/** GLB fixtures for Director Stage browser checks. */
import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";

function baseDocument() {
  return {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [
      {
        primitives: [
          {
            attributes: { POSITION: 0 },
            indices: 1,
          },
        ],
      },
    ],
    buffers: [{ byteLength: 42 }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 6 },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: "VEC3",
        min: [0, 0, 0],
        max: [1, 1, 0],
      },
      { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" },
    ],
  };
}

function baseBinary() {
  const binary = Buffer.alloc(44);
  binary.writeFloatLE(0, 0);
  binary.writeFloatLE(0, 4);
  binary.writeFloatLE(0, 8);
  binary.writeFloatLE(1, 12);
  binary.writeFloatLE(0, 16);
  binary.writeFloatLE(0, 20);
  binary.writeFloatLE(0, 24);
  binary.writeFloatLE(1, 28);
  binary.writeFloatLE(0, 32);
  binary.writeUInt16LE(0, 36);
  binary.writeUInt16LE(1, 38);
  binary.writeUInt16LE(2, 40);
  return binary;
}

const chunk = (type, data) => {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(data.length, 0);
  header.writeUInt32LE(type, 4);
  return Buffer.concat([header, data]);
};

function glbOf(document, binary) {
  const json = Buffer.from(JSON.stringify(document));
  const jsonChunk = Buffer.concat([
    json,
    Buffer.alloc((4 - (json.length % 4)) % 4, 0x20),
  ]);
  const body = Buffer.concat([
    chunk(0x4e4f534a, jsonChunk),
    chunk(0x004e4942, binary),
  ]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + body.length, 8);
  return Buffer.concat([header, body]);
}

export function makeGlb(overrides = {}) {
  return glbOf({ ...baseDocument(), ...overrides }, baseBinary());
}

/** A valid GLB container whose embedded JSON chunk cannot be parsed; the
 * browser probe must report corruption instead of external resources. */
export function makeCorruptGlb() {
  const json = Buffer.from("not json at all");
  const jsonChunk = Buffer.concat([
    json,
    Buffer.alloc((4 - (json.length % 4)) % 4, 0x20),
  ]);
  const body = chunk(0x4e4f534a, jsonChunk);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + body.length, 8);
  return Buffer.concat([header, body]);
}

/** A one-triangle GLB whose clip (optionally named) rotates the node 90
 * degrees in one second. An unnamed clip pins the animation_{index} fallback
 * shared with the backend probe. */
function animatedGlb(name) {
  const base = baseDocument();
  const document = {
    ...base,
    buffers: [{ byteLength: 84 }],
    bufferViews: [
      ...base.bufferViews,
      { buffer: 0, byteOffset: 44, byteLength: 8 },
      { buffer: 0, byteOffset: 52, byteLength: 32 },
    ],
    accessors: [
      ...base.accessors,
      {
        bufferView: 2,
        componentType: 5126,
        count: 2,
        type: "SCALAR",
        min: [0],
        max: [1],
      },
      { bufferView: 3, componentType: 5126, count: 2, type: "VEC4" },
    ],
    animations: [
      {
        ...(name ? { name } : {}),
        channels: [{ sampler: 0, target: { node: 0, path: "rotation" } }],
        samplers: [{ input: 2, output: 3, interpolation: "LINEAR" }],
      },
    ],
  };
  const binary = Buffer.alloc(84);
  baseBinary().copy(binary, 0);
  binary.writeFloatLE(0, 44);
  binary.writeFloatLE(1, 48);
  const half = Math.SQRT1_2;
  binary.writeFloatLE(0, 52);
  binary.writeFloatLE(0, 56);
  binary.writeFloatLE(0, 60);
  binary.writeFloatLE(1, 64);
  binary.writeFloatLE(0, 68);
  binary.writeFloatLE(0, 72);
  binary.writeFloatLE(half, 76);
  binary.writeFloatLE(half, 80);
  return glbOf(document, binary);
}

export function makeAnimatedGlb() {
  return animatedGlb("Walk");
}

export function makeUnnamedClipGlb() {
  return animatedGlb(undefined);
}

/** A GLB whose material is KHR_materials_unlit; browsers load it as a
 * MeshBasicMaterial with no emissive, which selection must tolerate. */
export function makeUnlitGlb() {
  return makeGlb({
    extensionsUsed: ["KHR_materials_unlit"],
    extensionsRequired: ["KHR_materials_unlit"],
    materials: [
      {
        pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] },
        extensions: { KHR_materials_unlit: {} },
      },
    ],
    meshes: [
      {
        primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }],
      },
    ],
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const destination = process.argv[2];
  if (!destination) throw new Error("Usage: node director_stage_fixture.mjs <path> [--animated]");
  writeFileSync(
    destination,
    process.argv.includes("--animated") ? makeAnimatedGlb() : makeGlb(),
  );
  console.log(destination);
}
