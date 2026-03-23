local M = {}

local config = require("act-nvim.config")
local tcp = require("act-nvim.tcp")

local server_job = nil
local augroup = nil
local connected = false
local project_root = nil

--- Find the relay.js entry point relative to this plugin
local function find_relay_path()
  local plugin_root = vim.fn.fnamemodify(
    debug.getinfo(1, "S").source:sub(2), -- strip @
    ":h:h:h" -- lua/act-nvim/init.lua -> plugin root
  )
  local built = plugin_root .. "/dist/server/relay.js"
  if vim.fn.filereadable(built) == 1 then
    return { "node", built }
  end
  local src = plugin_root .. "/src/server/relay.ts"
  if vim.fn.filereadable(src) == 1 then
    return { "npx", "tsx", src }
  end
  return nil
end

--- Open URL in default browser
local browser_opened = false

local function open_browser(url)
  if browser_opened then return end
  browser_opened = true

  -- Non-blocking browser open (only called once per session)
  local cmd
  if vim.fn.has("mac") == 1 then
    cmd = { "open", url }
  elseif vim.fn.has("unix") == 1 then
    cmd = { "xdg-open", url }
  else
    cmd = { "cmd", "/c", "start", url }
  end
  vim.fn.jobstart(cmd, { detach = true })
end

--- Handle messages from the relay server
local function on_message(msg)
  if msg.type == "error" then
    vim.notify("[act-nvim] " .. (msg.message or "unknown error"), vim.log.levels.ERROR)
    return
  end
  if msg.type == "browserConnected" then
    browser_opened = true
    return
  end
  if msg.type == "status" then
    if msg.browserConnected then
      browser_opened = true
      vim.notify("[act-nvim] browser tab already open", vim.log.levels.DEBUG)
    else
      open_browser("http://localhost:" .. config.http_port)
      vim.notify("[act-nvim] opened browser tab", vim.log.levels.DEBUG)
    end
    return
  end
  if msg.type == "navigate" then
    local file = msg.file
    if not vim.startswith(file, "/") then
      local root = project_root or vim.fn.getcwd()
      file = root .. "/" .. file
    end
    vim.cmd("edit " .. vim.fn.fnameescape(file))
    if msg.line then
      local line_count = vim.api.nvim_buf_line_count(0)
      local line = math.min(msg.line, line_count)
      local col = math.max((msg.col or 1) - 1, 0)
      vim.api.nvim_win_set_cursor(0, { line, col })
      -- select the word under cursor and center view
      vim.cmd("normal! viw")
      vim.cmd("normal! zz")
    end
  end
end

local function on_error(err)
  vim.notify("[act-nvim] " .. err, vim.log.levels.ERROR)
  connected = false
end

--- Send init to relay
local function send_init(target_root)
  local root = target_root or vim.fn.getcwd()
  project_root = root
  tcp.send({ type = "init", root = root })
  vim.notify("[act-nvim] scanning: " .. root, vim.log.levels.INFO)
end

--- Send buffer content to relay
local function send_buffer(bufnr)
  if not tcp.is_connected() then return end
  if not project_root then return end
  local abs_path = vim.api.nvim_buf_get_name(bufnr)

  -- path must be relative to the scanned project root
  if not vim.startswith(abs_path, project_root .. "/") then return end
  local rel = abs_path:sub(#project_root + 2)

  local lines = vim.api.nvim_buf_get_lines(bufnr, 0, -1, false)
  local content = table.concat(lines, "\n")

  tcp.send({
    type = "fileChanged",
    path = rel,
    content = content,
  })
end

local debounce_timer = nil

--- Set up autocmds for auto-refresh
local function setup_autocmd()
  if augroup then return end
  if not config.auto_refresh then return end

  augroup = vim.api.nvim_create_augroup("ActNvim", { clear = true })

  -- Immediate refresh on save
  vim.api.nvim_create_autocmd("BufWritePost", {
    group = augroup,
    pattern = { "*.ts", "*.tsx" },
    callback = function(ev)
      send_buffer(ev.buf)
    end,
  })

  -- Send LSP diagnostics to relay so browser can mark slices with errors
  vim.api.nvim_create_autocmd("DiagnosticChanged", {
    group = augroup,
    callback = function()
      if not tcp.is_connected() then return end
      if not project_root then return end

      -- Collect errors per file
      local file_errors = {}
      local diagnostics = vim.diagnostic.get(nil, { severity = vim.diagnostic.severity.ERROR })
      for _, d in ipairs(diagnostics) do
        local bufnr = d.bufnr
        if bufnr then
          local abs_path = vim.api.nvim_buf_get_name(bufnr)
          if vim.startswith(abs_path, project_root .. "/") then
            local rel = abs_path:sub(#project_root + 2)
            if not file_errors[rel] then
              file_errors[rel] = d.message
            end
          end
        end
      end

      tcp.send({
        type = "diagnostics",
        errors = file_errors,
      })

    end,
  })

  -- Debounced live refresh as you type
  vim.api.nvim_create_autocmd({ "TextChanged", "TextChangedI" }, {
    group = augroup,
    pattern = { "*.ts", "*.tsx" },
    callback = function(ev)
      if debounce_timer then
        debounce_timer:stop()
      end
      local bufnr = ev.buf
      debounce_timer = vim.defer_fn(function()
        debounce_timer = nil
        send_buffer(bufnr)
      end, 500)
    end,
  })
end

--- Connect to relay, send init, set up autocmds
local function connect_and_init(target_root)
  tcp.connect(config.tcp_port, on_message, on_error)
  connected = true

  -- give TCP a moment to establish, then send init
  vim.defer_fn(function()
    send_init(target_root)
    setup_autocmd()
  end, 200)
end

--- Kill orphan relay processes on a port (only kills node processes running relay.js)
local function kill_orphan_relay(port)
  local result = vim.fn.system("lsof -ti :" .. port)
  for pid in result:gmatch("%d+") do
    local cmdline = vim.fn.system("ps -p " .. pid .. " -o command=")
    if cmdline:find("relay") then
      vim.fn.system("kill " .. pid)
    end
  end
end

--- Spawn the relay server as a child process
local function spawn_relay()
  local cmd = find_relay_path()
  if not cmd then
    vim.notify("[act-nvim] relay server not found — run pnpm build first", vim.log.levels.ERROR)
    return false
  end

  -- Kill orphan relays before starting
  kill_orphan_relay(config.http_port)
  kill_orphan_relay(config.tcp_port)

  local env_http = "ACT_NVIM_HTTP_PORT=" .. config.http_port
  local env_tcp = "ACT_NVIM_TCP_PORT=" .. config.tcp_port

  server_job = vim.fn.jobstart(
    { "env", env_http, env_tcp, unpack(cmd) },
    {
      detach = true,
      on_stderr = function(_, data)
        for _, line in ipairs(data) do
          if #line > 0 then
            vim.schedule(function()
              vim.notify("[act-nvim relay] " .. line, vim.log.levels.DEBUG)
            end)
          end
        end
      end,
      on_exit = function()
        vim.schedule(function()
          server_job = nil
        end)
      end,
    }
  )
  return true
end

---@param opts? { args?: string }
local function start(opts)
  local target_root = nil
  if opts and opts.args and #opts.args > 0 then
    target_root = vim.fn.fnamemodify(opts.args, ":p"):gsub("/$", "")
  end

  -- already connected — just re-init with new root
  if connected and tcp.is_connected() then
    if target_root then
      project_root = target_root
      tcp.send({ type = "init", root = target_root })
      vim.notify("[act-nvim] re-scanning: " .. target_root, vim.log.levels.INFO)
    else
      vim.notify("[act-nvim] already running", vim.log.levels.WARN)
    end
    return
  end

  -- Always spawn a fresh relay (kills orphans first)
  vim.notify("[act-nvim] starting relay server...", vim.log.levels.INFO)
  if spawn_relay() then
    vim.defer_fn(function()
      connect_and_init(target_root)
    end, 500)
  end
end

local function stop()
  tcp.disconnect()
  connected = false
  browser_opened = false

  if augroup then
    vim.api.nvim_del_augroup_by_id(augroup)
    augroup = nil
  end

  if server_job then
    vim.fn.jobstop(server_job)
    server_job = nil
  end

  vim.notify("[act-nvim] stopped", vim.log.levels.INFO)
end

---@param opts? table
function M.setup(opts)
  if opts then
    for k, v in pairs(opts) do
      if config[k] ~= nil then
        config[k] = v
      end
    end
  end

  vim.api.nvim_create_user_command("ActDiagram", start, {
    nargs = "?",
    complete = "dir",
    desc = "Open Act diagram in browser (optional: path to project)",
  })
  vim.api.nvim_create_user_command("ActDiagramClose", stop, {
    desc = "Close Act diagram",
  })

  -- Disconnect TCP when Neovim exits (but leave the relay running for tab reuse)
  vim.api.nvim_create_autocmd("VimLeavePre", {
    callback = function()
      tcp.disconnect()
      connected = false
      if augroup then
        vim.api.nvim_del_augroup_by_id(augroup)
        augroup = nil
      end
    end,
  })
end

return M
