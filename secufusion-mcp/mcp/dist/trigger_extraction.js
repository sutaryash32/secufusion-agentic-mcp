import { performFullExtraction } from "./server.js";
console.log("Triggering extraction...");
const stats = performFullExtraction("c:\\Users\\Yash\\Desktop\\mcp");
console.log("Extraction complete", stats);
