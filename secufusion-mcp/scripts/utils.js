import * as fs from 'fs';
import * as path from 'path';
export function getWorkspaceRoot() {
    let currentDir = process.cwd();
    const rootMarkers = [".git", "package.json", "pom.xml", ".secufusion-project-spec.json", ".agents"];
    for (let i = 0; i < 10; i++) {
        for (const marker of rootMarkers) {
            if (fs.existsSync(path.join(currentDir, marker))) {
                return currentDir;
            }
        }
        const parent = path.dirname(currentDir);
        if (parent === currentDir)
            break;
        currentDir = parent;
    }
    return process.cwd();
}
export function resolve(file) {
    return path.resolve(getWorkspaceRoot(), file);
}
export function readFileSafe(filePath) {
    try {
        return fs.readFileSync(filePath, "utf-8");
    }
    catch {
        return null;
    }
}
