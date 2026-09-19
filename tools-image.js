// Image tools for the MCP server.
//
// MCP clients can render tool results of type "image", so these tools let a
// model actually look at a file on disk instead of only reading bytes as text.
// The pixel work is done by Pillow through a short python3 program, because
// Pillow is already installed on this machine and needs no extra node deps.
import { execFile } from "child_process";
import { z } from "zod";
import { assertAllowed } from "./security.js";

const ok = (text) => ({ content: [{ type: "text", text }] });
const err = (text) => ({ content: [{ type: "text", text }], isError: true });

const PYTHON = process.env.MCP_PYTHON || "python3";

// Runs a python program and parses the single JSON object it prints on stdout.
// Payloads travel as argv JSON, so no quoting or heredoc rules apply, and
// base64 image data comes back on stdout with a generous maxBuffer.
const runPython = (program, payload) =>
    new Promise((resolve) => {
        execFile(
            PYTHON,
            ["-c", program, JSON.stringify(payload)],
            { maxBuffer: 256 * 1024 * 1024 },
            (error, stdout, stderr) => {
                if (error) {
                    resolve({ error: `${error.message}\n${stderr}` });
                    return;
                }
                try {
                    resolve({ value: JSON.parse(stdout) });
                } catch (parseError) {
                    resolve({
                        error: `Could not parse python output: ${parseError.message}\n${stdout.slice(0, 2000)}\n${stderr}`
                    });
                }
            }
        );
    });

const READ_IMAGE_PY = `
import base64, io, json, sys
from PIL import Image, ImageOps

args = json.loads(sys.argv[1])
Image.MAX_IMAGE_PIXELS = None

image = Image.open(args["path"])
image.load()
meta = {
    "originalWidth": image.width,
    "originalHeight": image.height,
    "mode": image.mode,
    "sourceFormat": image.format,
    "frames": getattr(image, "n_frames", 1),
}

frame = args.get("frame") or 0
if frame:
    image.seek(frame)

crop = args.get("crop")
if crop:
    left = int(crop["x"])
    top = int(crop["y"])
    box = (left, top, left + int(crop["w"]), top + int(crop["h"]))
    image = image.crop(box)
    meta["crop"] = {"x": box[0], "y": box[1], "w": box[2] - box[0], "h": box[3] - box[1]}

if image.mode == "P":
    image = image.convert("RGBA")
elif image.mode in ("I;16", "I", "F"):
    image = image.convert("L")

# A checkerboard makes transparent regions readable instead of pure black,
# which matters for UI art exported with an alpha channel.
if image.mode in ("RGBA", "LA") and args.get("flattenAlpha", True):
    flat = Image.new("RGB", image.size, (32, 32, 32))
    tile = 16
    light = Image.new("RGB", (tile, tile), (64, 64, 64))
    for y in range(0, image.height, tile):
        for x in range(0, image.width, tile):
            if ((x // tile) + (y // tile)) % 2 == 0:
                flat.paste(light, (x, y))
    flat.paste(image.convert("RGBA"), (0, 0), image.convert("RGBA"))
    image = flat

scale = 1.0
max_width = args.get("maxWidth") or 0
max_height = args.get("maxHeight") or 0
if max_width and image.width > max_width:
    scale = min(scale, max_width / image.width)
if max_height and image.height > max_height:
    scale = min(scale, max_height / image.height)
if scale < 1.0:
    image = image.resize(
        (max(1, round(image.width * scale)), max(1, round(image.height * scale))),
        Image.LANCZOS,
    )

if args.get("grid"):
    step = int(args["grid"])
    if step > 1:
        image = image.convert("RGB")
        pixels = image.load()
        for y in range(0, image.height, step):
            for x in range(image.width):
                pixels[x, y] = (255, 0, 255)
        for x in range(0, image.width, step):
            for y in range(image.height):
                pixels[x, y] = (255, 0, 255)
        meta["gridStep"] = step

max_bytes = int(args.get("maxBytes") or 1_200_000)


def encode(fmt, quality=None):
    buffer = io.BytesIO()
    if fmt == "jpeg":
        buffer = io.BytesIO()
        image.convert("RGB").save(buffer, "JPEG", quality=quality or 85, optimize=True)
        return buffer.getvalue(), "image/jpeg"
    image.save(buffer, "PNG", optimize=True)
    return buffer.getvalue(), "image/png"


fmt = args.get("format") or "png"
data, mime = encode(fmt, args.get("quality"))

# Stay inside the client's payload budget: try JPEG, then shrink further.
if len(data) > max_bytes and fmt != "jpeg":
    data, mime = encode("jpeg", args.get("quality") or 82)
while len(data) > max_bytes and min(image.width, image.height) > 64:
    image = image.resize(
        (max(1, round(image.width * 0.75)), max(1, round(image.height * 0.75))),
        Image.LANCZOS,
    )
    data, mime = encode("jpeg", args.get("quality") or 82)

meta.update(
    {
        "returnedWidth": image.width,
        "returnedHeight": image.height,
        "bytes": len(data),
        "mimeType": mime,
    }
)
print(json.dumps({"meta": meta, "data": base64.b64encode(data).decode("ascii")}))
`;

const COMPARE_PY = `
import base64, io, json, math, sys
from PIL import Image, ImageChops

args = json.loads(sys.argv[1])
Image.MAX_IMAGE_PIXELS = None

first = Image.open(args["a"])
first.load()
second = Image.open(args["b"])
second.load()

meta = {
    "a": {"width": first.width, "height": first.height},
    "b": {"width": second.width, "height": second.height},
}

first = first.convert("RGB")
second = second.convert("RGB")

if first.size != second.size:
    if not args.get("resize", True):
        print(json.dumps({"error": "sizes differ and resize is disabled"}))
        raise SystemExit(0)
    second = second.resize(first.size, Image.LANCZOS)
    meta["resized"] = {"to": [first.width, first.height]}

diff = ImageChops.difference(first, second)
gray = diff.convert("L")
histogram = gray.histogram()
total = sum(histogram) or 1
mae = sum(value * count for value, count in enumerate(histogram)) / total
rmse = math.sqrt(sum(value * value * count for value, count in enumerate(histogram)) / total)
threshold = int(args.get("threshold", 12))
changed = sum(count for value, count in enumerate(histogram) if value > threshold)

# Where the differences are, as a coarse 4 x 4 map: enough to say "the left
# column is off" without looking at every pixel.
regions = []
cols = int(args.get("regions", 4))
rows = cols
for row in range(rows):
    for col in range(cols):
        box = (
            round(col * gray.width / cols),
            round(row * gray.height / rows),
            round((col + 1) * gray.width / cols),
            round((row + 1) * gray.height / rows),
        )
        tile = gray.crop(box)
        tile_histogram = tile.histogram()
        tile_total = sum(tile_histogram) or 1
        regions.append(
            {
                "box": [box[0], box[1], box[2] - box[0], box[3] - box[1]],
                "mae": round(
                    sum(v * c for v, c in enumerate(tile_histogram)) / tile_total, 3
                ),
                "changedPercent": round(
                    100.0
                    * sum(c for v, c in enumerate(tile_histogram) if v > threshold)
                    / tile_total,
                    3,
                ),
            }
        )

# Bounding box of everything above the threshold, in pixels.
mask = gray.point(lambda value: 255 if value > threshold else 0)
meta["changedBoundingBox"] = list(mask.getbbox() or [])

meta.update(
    {
        "mae": round(mae, 4),
        "rmse": round(rmse, 4),
        "changedPercent": round(100.0 * changed / total, 4),
        "threshold": threshold,
        "maxChannelDifference": max(v for v, c in enumerate(histogram) if c),
        "regions": regions,
    }
)

result = {"meta": meta}

visual = ImageChops.multiply(diff, Image.new("RGB", diff.size, (4, 4, 4)))
out_path = args.get("diffPath")
if out_path:
    visual.save(out_path)
    meta["diffPath"] = out_path

if args.get("returnImage", True):
    max_width = int(args.get("maxWidth") or 1400)
    if visual.width > max_width:
        scale = max_width / visual.width
        visual = visual.resize(
            (max(1, round(visual.width * scale)), max(1, round(visual.height * scale))),
            Image.LANCZOS,
        )
    buffer = io.BytesIO()
    visual.save(buffer, "PNG", optimize=True)
    data = buffer.getvalue()
    if len(data) > int(args.get("maxBytes") or 1_200_000):
        buffer = io.BytesIO()
        visual.save(buffer, "JPEG", quality=82, optimize=True)
        result["mimeType"] = "image/jpeg"
        data = buffer.getvalue()
    else:
        result["mimeType"] = "image/png"
    result["data"] = base64.b64encode(data).decode("ascii")

print(json.dumps(result))
`;

export function registerImageTools(defineTool, log) {
    // -----------------------------
    // readImage
    // -----------------------------
    defineTool(
        "readImage",
        "View an image file (png/jpg/webp/bmp/tiff/gif). Returns the image itself, downscaled to fit the payload budget, with optional crop and measuring grid. Use crop to inspect one region at full resolution.",
        {
            path: z.string().describe("Path to the image file"),
            maxWidth: z.number().optional().default(1400).describe("Downscale so the width does not exceed this; 0 disables"),
            maxHeight: z.number().optional().describe("Downscale so the height does not exceed this"),
            crop: z
                .object({
                    x: z.number().describe("Left edge in pixels"),
                    y: z.number().describe("Top edge in pixels"),
                    w: z.number().describe("Width in pixels"),
                    h: z.number().describe("Height in pixels")
                })
                .optional()
                .describe("Crop this region before scaling"),
            grid: z.number().optional().describe("Draw a magenta measuring grid every N pixels (after scaling)"),
            format: z.enum(["png", "jpeg"]).optional().default("png").describe("Encoding to return"),
            quality: z.number().optional().describe("JPEG quality (1-95)"),
            flattenAlpha: z.boolean().optional().default(true).describe("Composite transparency onto a checkerboard"),
            frame: z.number().optional().describe("Frame index for animated images"),
            maxBytes: z.number().optional().default(1_200_000).describe("Payload budget; the image is re-encoded and shrunk to fit")
        },
        async ({ path: filePath, ...rest }) => {
            log("Reading image:", filePath);
            let resolved;
            try {
                resolved = assertAllowed(filePath);
            } catch (error) {
                return err(error.message);
            }
            const result = await runPython(READ_IMAGE_PY, { path: resolved, ...rest });
            if (result.error) return err(result.error);
            const { meta, data } = result.value;
            return {
                content: [
                    { type: "image", data, mimeType: meta.mimeType },
                    { type: "text", text: JSON.stringify(meta) }
                ]
            };
        }
    );

    // -----------------------------
    // compareImages
    // -----------------------------
    defineTool(
        "compareImages",
        "Compare two images numerically and visually: mean/RMS difference, share of differing pixels, a 4x4 region map, the bounding box of the differences, and an amplified diff image.",
        {
            a: z.string().describe("Path to the reference image"),
            b: z.string().describe("Path to the image being checked"),
            resize: z.boolean().optional().default(true).describe("Resize b to a's size when they differ"),
            threshold: z.number().optional().default(12).describe("Per-pixel difference counted as a change (0-255)"),
            regions: z.number().optional().default(4).describe("Region map granularity (N x N)"),
            diffPath: z.string().optional().describe("Also write the diff image to this path"),
            returnImage: z.boolean().optional().default(true).describe("Return the diff image inline"),
            maxWidth: z.number().optional().default(1400).describe("Downscale the returned diff image to this width"),
            maxBytes: z.number().optional().default(1_200_000).describe("Payload budget for the returned diff image")
        },
        async ({ a, b, diffPath, ...rest }) => {
            log("Comparing images:", a, b);
            let payload;
            try {
                payload = {
                    a: assertAllowed(a),
                    b: assertAllowed(b),
                    ...(diffPath ? { diffPath: assertAllowed(diffPath) } : {}),
                    ...rest
                };
            } catch (error) {
                return err(error.message);
            }
            const result = await runPython(COMPARE_PY, payload);
            if (result.error) return err(result.error);
            if (result.value.error) return err(result.value.error);
            const { meta, data, mimeType } = result.value;
            const content = [];
            if (data) content.push({ type: "image", data, mimeType });
            content.push({ type: "text", text: JSON.stringify(meta) });
            return { content };
        }
    );
}
