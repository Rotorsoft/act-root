const fs = require("fs");
const path = require("path");
const envPath = path.join(__dirname, "..", ".env");
const envContent =
  "DATABASE_URL=postgres://betblox:betblox@localhost:5432/betblox\n";

if (fs.existsSync(envPath)) {
  console.log(".env already exists at", envPath);
} else {
  fs.writeFileSync(envPath, envContent);
  console.log(".env created at", envPath);
}
