import fs from "fs";
import path from "path";

const dbPath = path.join(process.cwd(), "db.json");
if (fs.existsSync(dbPath)) {
  try {
    fs.unlinkSync(dbPath);
    console.log("Successfully deleted db.json file.");
  } catch (err) {
    console.error("Error deleting db.json:", err);
  }
} else {
  console.log("db.json was already empty or not present.");
}
