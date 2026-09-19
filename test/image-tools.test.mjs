// Smoke test for the image tools: run with `node test/image-tools.test.mjs`.
// It renders two small images with Pillow and checks that readImage returns
// real image content and that compareImages reports the expected difference.
import { execFileSync } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { registerImageTools } from "../tools-image.js";

const PYTHON = process.env.MCP_PYTHON || "python3";

const tools = new Map();
registerImageTools((name, description, schema, handler) => {
    tools.set(name, { schema, handler });
}, () => {});

// Zod defaults live in the schema, and the MCP SDK applies them before the
// handler runs, so the test applies them too.
const call = (name, args) => {
    const tool = tools.get(name);
    const parsed = {};
    for (const [key, field] of Object.entries(tool.schema)) {
        const result = field.safeParse(args[key]);
        if (result.success && result.data !== undefined) parsed[key] = result.data;
    }
    return tool.handler(parsed);
};

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-image-"));
const red = path.join(dir, "red.png");
const shifted = path.join(dir, "shifted.png");

execFileSync(PYTHON, [
    "-c",
    [
        "from PIL import Image",
        "import sys",
        "a = Image.new('RGB', (64, 48), (200, 30, 30))",
        "a.save(sys.argv[1])",
        "b = a.copy()",
        "b.paste((30, 200, 30), (0, 0, 32, 48))",
        "b.save(sys.argv[2])"
    ].join("\n"),
    red,
    shifted
]);

const assert = (condition, message) => {
    if (!condition) {
        console.error("FAIL:", message);
        process.exitCode = 1;
    } else {
        console.log("ok:", message);
    }
};

const read = await call("readImage", { path: red });
assert(!read.isError, "readImage succeeded");
const image = read.content.find((item) => item.type === "image");
assert(image && image.data.length > 50, "readImage returned image content");
assert(image && image.mimeType === "image/png", "readImage returned a png");
const meta = JSON.parse(read.content.find((item) => item.type === "text").text);
assert(meta.originalWidth === 64 && meta.originalHeight === 48, "readImage reported the source size");

const cropped = await call("readImage", { path: red, crop: { x: 8, y: 8, w: 16, h: 16 } });
const croppedMeta = JSON.parse(cropped.content.find((item) => item.type === "text").text);
assert(croppedMeta.returnedWidth === 16 && croppedMeta.returnedHeight === 16, "readImage honoured the crop");

const scaled = await call("readImage", { path: red, maxWidth: 32 });
const scaledMeta = JSON.parse(scaled.content.find((item) => item.type === "text").text);
assert(scaledMeta.returnedWidth === 32, "readImage honoured maxWidth");

const diffPath = path.join(dir, "diff.png");
const compared = await call("compareImages", { a: red, b: shifted, diffPath });
assert(!compared.isError, "compareImages succeeded");
const comparedMeta = JSON.parse(compared.content.find((item) => item.type === "text").text);
assert(Math.abs(comparedMeta.changedPercent - 50) < 1, `compareImages found half the image changed (${comparedMeta.changedPercent}%)`);
assert(comparedMeta.regions.length === 16, "compareImages returned a 4x4 region map");
assert(
    comparedMeta.changedBoundingBox.length === 4 && comparedMeta.changedBoundingBox[2] === 32,
    "compareImages bounded the changed area to the left half"
);
assert((await fs.stat(diffPath)).size > 0, "compareImages wrote the diff image");

const identical = await call("compareImages", { a: red, b: red, returnImage: false });
const identicalMeta = JSON.parse(identical.content.find((item) => item.type === "text").text);
assert(identicalMeta.changedPercent === 0 && identicalMeta.mae === 0, "compareImages reports zero difference for identical files");

const missing = await call("readImage", { path: path.join(dir, "nope.png") });
assert(missing.isError === true, "readImage reports a missing file as an error");

await fs.rm(dir, { recursive: true, force: true });
console.log(process.exitCode ? "FAILED" : "all image tool checks passed");
