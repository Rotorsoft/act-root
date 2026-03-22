local M = {}

local uv = vim.uv or vim.loop

---@type uv_tcp_t|nil
local client = nil
local buffer = ""

---@param port integer
---@param on_message fun(msg: table)
---@param on_error fun(err: string)
function M.connect(port, on_message, on_error)
  if client then
    M.disconnect()
  end

  client = uv.new_tcp()
  buffer = ""

  client:connect("127.0.0.1", port, function(err)
    if err then
      on_error("TCP connect failed: " .. err)
      M.disconnect()
      return
    end

    client:read_start(function(read_err, data)
      if read_err then
        on_error("TCP read error: " .. read_err)
        M.disconnect()
        return
      end

      if not data then
        -- connection closed
        M.disconnect()
        return
      end

      -- buffer NDJSON
      buffer = buffer .. data
      while true do
        local nl = buffer:find("\n")
        if not nl then break end
        local line = buffer:sub(1, nl - 1)
        buffer = buffer:sub(nl + 1)
        if #line > 0 then
          local ok, msg = pcall(vim.json.decode, line)
          if ok and msg then
            vim.schedule(function()
              on_message(msg)
            end)
          end
        end
      end
    end)
  end)
end

---@param msg table
function M.send(msg)
  if client then
    local data = vim.json.encode(msg) .. "\n"
    client:write(data)
  end
end

function M.disconnect()
  if client then
    if not client:is_closing() then
      client:read_stop()
      client:shutdown()
      client:close()
    end
    client = nil
    buffer = ""
  end
end

function M.is_connected()
  return client ~= nil
end

return M
