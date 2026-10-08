import { performFullExtraction } from "./shared.js";
console.log("Triggering extraction...");
const stats = performFullExtraction("c:\\Users\\Yash\\Desktop\\mcp");
console.log("Extraction complete", stats);
