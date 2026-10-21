// Hardware catalogue for the model advisor.
// mem: memory the model can use (GB); bw: memory bandwidth (GB/s), which bounds generation speed.
// Figures are public spec-sheet values; "usable" fractions are applied in engine.js.

/**
 * GPU architecture decides which low-precision formats run natively:
 * Blackwell → FP4 (NVFP4) and FP8; Hopper / Ada / CDNA3 → FP8; Ampere / Turing → INT8 and INT4 (AWQ/GPTQ).
 */
export function archOf(name) {
  const n = name.toLowerCase();
  if (/\bada\b/.test(n)) return 'ada';
  if (/rtx 50|rtx pro|blackwell|\bb[23]00\b|gb10|gb300|thor/.test(n)) return 'blackwell';
  if (/h100|h200|gh200/.test(n)) return 'hopper';
  if (/rtx 40|ada|l40s|(^|\s)l4$/.test(n)) return 'ada';
  if (/rtx 30|a100|(^|\s)a10$|rtx a\d|orin/.test(n)) return 'ampere';
  if (/rtx 20|t4/.test(n)) return 'turing';
  if (/mi300|mi325/.test(n)) return 'cdna3';
  if (/mi35\d/.test(n)) return 'cdna4';
  if (/rx 9070/.test(n)) return 'rdna4';
  if (/radeon|ryzen ai/.test(n)) return 'rdna3';
  if (/arc/.test(n)) return 'xe';
  return 'ampere';
}
export const vendorOf = (name) => (/radeon|instinct|ryzen/i.test(name) ? 'amd' : /arc/i.test(name) ? 'intel' : 'nvidia');

export const ARCH_LABEL = {
  blackwell: 'Blackwell (native FP4 + FP8)', hopper: 'Hopper (native FP8)', ada: 'Ada Lovelace (native FP8)',
  ampere: 'Ampere (INT8 / INT4)', turing: 'Turing (INT8 / INT4)', cdna3: 'AMD CDNA 3 (FP8)', cdna4: 'AMD CDNA 4 (FP8, FP6 / FP4)', rdna4: 'AMD RDNA 4', rdna3: 'AMD RDNA 3',
  xe: 'Intel Xe', apple: 'Apple Silicon',
};

// [name, VRAM GB, memory bandwidth GB/s, dense FP16 / BF16 tensor TFLOPS with FP32 accumulate (vendor spec
// sheets; it sets how fast a prompt is read). Bandwidth sets how fast tokens are generated.
export const GPUS = [
  { group: 'NVIDIA GeForce RTX 50', items: [
    ['RTX 5090', 32, 1792, 209.5], ['RTX 5080', 16, 960, 112.6], ['RTX 5070 Ti', 16, 896, 87.9], ['RTX 5070', 12, 672, 61.7],
    ['RTX 5060 Ti 16 GB', 16, 448, 47.4], ['RTX 5060 Ti 8 GB', 8, 448, 47.4], ['RTX 5060', 8, 448, 38.4],
  ] },
  { group: 'NVIDIA GeForce RTX 40', items: [
    ['RTX 4090', 24, 1008, 165.2], ['RTX 4080 Super', 16, 736, 104.4], ['RTX 4080', 16, 717, 97.5], ['RTX 4070 Ti Super', 16, 672, 88.2],
    ['RTX 4070 Ti', 12, 504, 80.2], ['RTX 4070 Super', 12, 504, 71], ['RTX 4070', 12, 504, 58.3], ['RTX 4060 Ti 16 GB', 16, 288, 44.1],
    ['RTX 4060 Ti 8 GB', 8, 288, 44.1], ['RTX 4060', 8, 272, 30.2],
  ] },
  { group: 'NVIDIA GeForce RTX 30 / 20', items: [
    ['RTX 3090 Ti', 24, 1008, 80], ['RTX 3090', 24, 936, 71], ['RTX 3080 Ti', 12, 912, 68.2], ['RTX 3080 12 GB', 12, 912, 61.2],
    ['RTX 3080 10 GB', 10, 760, 59.5], ['RTX 3070 Ti', 8, 608, 43.5], ['RTX 3070', 8, 448, 40.6], ['RTX 3060 Ti', 8, 448, 32.4],
    ['RTX 3060 12 GB', 12, 360, 25.4], ['RTX 2080 Ti', 11, 616, 56.9], ['RTX 2060 12 GB', 12, 336, 28.7],
  ] },
  { group: 'NVIDIA laptop GPUs', items: [
    ['RTX 5090 Laptop', 24, 896, 64], ['RTX 5080 Laptop', 16, 896, 50], ['RTX 4090 Laptop', 16, 576, 66], ['RTX 4080 Laptop', 12, 432, 49],
    ['RTX 4070 Laptop', 8, 256, 31], ['RTX 4060 Laptop', 8, 256, 23], ['RTX 3080 Ti Laptop', 16, 512, 47],
  ] },
  { group: 'NVIDIA workstation', items: [
    ['RTX PRO 6000 Blackwell', 96, 1792, 500], ['RTX PRO 5000 Blackwell', 48, 1344, 258], ['RTX PRO 4500 Blackwell', 32, 896, 165],
    ['RTX PRO 4000 Blackwell', 24, 672, 125], ['RTX 6000 Ada', 48, 960, 364],
    ['RTX 5000 Ada', 32, 576, 261], ['RTX 4500 Ada', 24, 432, 158], ['RTX 4000 Ada', 20, 360, 82], ['RTX A6000', 48, 768, 155],
    ['RTX A5000', 24, 768, 111], ['RTX A4000', 16, 448, 77],
  ] },
  { group: 'NVIDIA data centre', items: [
    ['B300', 288, 8000, 2250], ['B200', 192, 8000, 2250], ['H200', 141, 4800, 989], ['GH200', 96, 4000, 989], ['H100 SXM', 80, 3350, 989], ['H100 PCIe', 80, 2000, 756],
    ['A100 80 GB', 80, 2039, 312], ['A100 40 GB', 40, 1555, 312], ['L40S', 48, 864, 362], ['A10', 24, 600, 125], ['L4', 24, 300, 121], ['T4', 16, 320, 65],
  ] },
  { group: 'AMD Radeon / Instinct', items: [
    ['Radeon RX 9070 XT', 16, 640, 195], ['Radeon RX 9070', 16, 640, 145], ['Radeon RX 7900 XTX', 24, 960, 123], ['Radeon RX 7900 XT', 20, 800, 103],
    ['Radeon RX 7900 GRE', 16, 576, 92], ['Radeon RX 7800 XT', 16, 624, 75], ['Radeon RX 7600 XT', 16, 288, 45], ['Radeon RX 7600', 8, 288, 43],
    ['Radeon PRO W7900', 48, 864, 123], ['Instinct MI300X', 192, 5300, 1307], ['Instinct MI325X', 256, 6000, 1307],
    ['Instinct MI350X', 288, 8000, 2300], ['Instinct MI355X', 288, 8000, 2500],
  ] },
  { group: 'Intel Arc', items: [
    ['Arc Pro B60', 24, 456, 98], ['Arc B580', 12, 456, 117], ['Arc A770 16 GB', 16, 560, 138],
  ] },
].map((g) => ({ ...g, items: g.items.map(([name, mem, bw, tf]) => ({ id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name, mem, bw, tf, arch: archOf(name), vendor: vendorOf(name) })) }));

/** Unified-memory machines: CPU and GPU share one pool. `usable` is how much a model can realistically get. */
export const UNIFIED = [
  { id: 'dgx-spark', name: 'NVIDIA DGX Spark (GB10, 128 GB)', arch: 'blackwell', vendor: 'nvidia', arm: true, mem: 128, usable: 119, bw: 273, tf: 125, note: 'Also ASUS Ascent GX10, Dell Pro Max GB10, HP ZGX Nano, Lenovo ThinkStation PGX, MSI EdgeXpert. Two units can be linked for ~240 GB.', cluster: 2 },
  { id: 'dgx-station', name: 'NVIDIA DGX Station (GB300)', arch: 'blackwell', vendor: 'nvidia', arm: true, mem: 288, usable: 270, bw: 8000, tf: 2500, note: '288 GB of HBM3e on the GPU (plus slower LPDDR5X for the CPU).' },
  { id: 'jetson-thor', name: 'NVIDIA Jetson AGX Thor (128 GB)', arch: 'blackwell', vendor: 'nvidia', arm: true, mem: 128, usable: 110, bw: 273, tf: 259, note: 'Robotics / edge module.' },
  { id: 'jetson-orin-64', name: 'NVIDIA Jetson AGX Orin (64 GB)', arch: 'ampere', vendor: 'nvidia', arm: true, mem: 64, usable: 52, bw: 204, tf: 42, note: 'Edge module.' },
  { id: 'jetson-orin-nano', name: 'NVIDIA Jetson Orin Nano Super (8 GB)', arch: 'ampere', vendor: 'nvidia', arm: true, mem: 8, usable: 5.5, bw: 102, tf: 8.5, note: 'Small edge board: stick to models under ~4B.' },
  { id: 'strix-halo-128', name: 'AMD Ryzen AI Max+ 395 (128 GB)', arch: 'rdna3', vendor: 'amd', mem: 128, usable: 110, bw: 256, tf: 59, note: 'Framework Desktop, GMKtec EVO-X2, ASUS ROG Flow Z13 and others. Up to ~110 GB can be given to the GPU on Linux (96 GB on Windows).' },
  { id: 'strix-halo-64', name: 'AMD Ryzen AI Max (64 GB)', arch: 'rdna3', vendor: 'amd', mem: 64, usable: 48, bw: 256, tf: 59, note: 'Up to 48 GB can be assigned to the GPU.' },
];

/** Apple Silicon chips: bandwidth and the memory sizes they were sold with. */
// [chip, bandwidth GB/s (top GPU configuration), memory sizes, GPU FP32 TFLOPS]. The M5 GPU adds neural
// accelerators that Apple rates at ~4× the M4's AI compute, which mostly speeds up reading prompts.
export const MAC_CHIPS = [
  ['M1', 68, [8, 16], 2.6], ['M1 Pro', 200, [16, 32], 5.2], ['M1 Max', 400, [32, 64], 10.4], ['M1 Ultra', 800, [64, 128], 21],
  ['M2', 100, [8, 16, 24], 3.6], ['M2 Pro', 200, [16, 32], 6.8], ['M2 Max', 400, [32, 64, 96], 13.6], ['M2 Ultra', 800, [64, 128, 192], 27.2],
  ['M3', 100, [8, 16, 24], 4.1], ['M3 Pro', 150, [18, 36], 7.4], ['M3 Max', 400, [36, 48, 64, 96, 128], 16.4], ['M3 Ultra', 819, [96, 256, 512], 28.4],
  ['M4', 120, [16, 24, 32], 4.3], ['M4 Pro', 273, [24, 48, 64], 9.2], ['M4 Max', 546, [36, 48, 64, 128], 18.4],
  ['M5', 153, [16, 24, 32], 15],
].map(([name, bw, sizes, tf]) => ({ id: name.toLowerCase().replace(/\s+/g, '-'), name, bw, sizes, tf }));

/** System RAM bandwidth for CPU-only inference (or the part of a model that overflows to RAM). */
export const CPU_MEMORY = [
  { id: 'ddr4', name: 'Desktop / laptop, DDR4', bw: 45, tf: 0.8 },
  { id: 'ddr5', name: 'Desktop / laptop, DDR5', bw: 80, tf: 1.5 },
  { id: 'lpddr5x', name: 'Thin laptop, LPDDR5X', bw: 110, tf: 1 },
  { id: 'hedt', name: 'Workstation, 4–8 channels (Threadripper / Xeon W)', bw: 250, tf: 4 },
  { id: 'server', name: 'Server, 12 channels (EPYC / Xeon)', bw: 450, tf: 8 },
];
export const RAM_SIZES = [8, 16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512, 768, 1024];

/** One-click starting points. */
export const PRESETS = [
  { label: 'Gaming PC · RTX 4070', state: { hw: 'gpu', gpu: 'rtx-4070', ngpu: 1, ram: 32, cpuMem: 'ddr5' } },
  { label: 'RTX 4090 workstation', state: { hw: 'gpu', gpu: 'rtx-4090', ngpu: 1, ram: 64, cpuMem: 'ddr5' } },
  { label: 'RTX 5090', state: { hw: 'gpu', gpu: 'rtx-5090', ngpu: 1, ram: 64, cpuMem: 'ddr5' } },
  { label: '2× RTX 3090 rig', state: { hw: 'gpu', gpu: 'rtx-3090', ngpu: 2, ram: 64, cpuMem: 'ddr4' } },
  { label: 'NVIDIA DGX Spark', state: { hw: 'gpu', gpu: 'dgx-spark', ngpu: 1, runtime: 'vllm' } },
  { label: 'Ryzen AI Max+ 395 128 GB', state: { hw: 'gpu', gpu: 'strix-halo-128', ngpu: 1 } },
  { label: 'MacBook Air M4 · 16 GB', state: { hw: 'mac', chip: 'm4', mac: 16 } },
  { label: 'MacBook Pro M4 Max · 64 GB', state: { hw: 'mac', chip: 'm4-max', mac: 64 } },
  { label: 'Mac Studio M3 Ultra · 512 GB', state: { hw: 'mac', chip: 'm3-ultra', mac: 512 } },
  { label: 'Laptop, no GPU · 16 GB', state: { hw: 'cpu', ram: 16, cpuMem: 'ddr5' } },
  { label: '8× H100 server', state: { hw: 'gpu', gpu: 'h100-sxm', ngpu: 8, ram: 1024, cpuMem: 'server', runtime: 'vllm' } },
];

/** Unified-memory machines also appear in the graphics-card list (they are a GPU with a big shared pool). */
export const UNIFIED_GROUPS = [
  { group: 'NVIDIA DGX & Jetson · unified memory', items: UNIFIED.filter((u) => u.vendor === 'nvidia') },
  { group: 'AMD Ryzen AI Max · unified memory', items: UNIFIED.filter((u) => u.vendor === 'amd') },
].map((g) => ({ ...g, items: g.items.map((u) => ({ ...u, unified: true, mem: u.usable })) }));

export const allGpus = () => [...UNIFIED_GROUPS, ...GPUS].flatMap((g) => g.items);
export const gpuById = (id) => allGpus().find((g) => g.id === id);
