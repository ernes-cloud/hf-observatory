// Hardware catalogue for the model advisor.
// mem: memory the model can use (GB); bw: memory bandwidth (GB/s), which bounds generation speed.
// Figures are public spec-sheet values; "usable" fractions are applied in engine.js.

export const GPUS = [
  { group: 'NVIDIA GeForce RTX 50', items: [
    ['RTX 5090', 32, 1792], ['RTX 5080', 16, 960], ['RTX 5070 Ti', 16, 896], ['RTX 5070', 12, 672],
    ['RTX 5060 Ti 16 GB', 16, 448], ['RTX 5060 Ti 8 GB', 8, 448], ['RTX 5060', 8, 448],
  ] },
  { group: 'NVIDIA GeForce RTX 40', items: [
    ['RTX 4090', 24, 1008], ['RTX 4080 Super', 16, 736], ['RTX 4080', 16, 717], ['RTX 4070 Ti Super', 16, 672],
    ['RTX 4070 Ti', 12, 504], ['RTX 4070 Super', 12, 504], ['RTX 4070', 12, 504], ['RTX 4060 Ti 16 GB', 16, 288],
    ['RTX 4060 Ti 8 GB', 8, 288], ['RTX 4060', 8, 272],
  ] },
  { group: 'NVIDIA GeForce RTX 30 / 20', items: [
    ['RTX 3090 Ti', 24, 1008], ['RTX 3090', 24, 936], ['RTX 3080 Ti', 12, 912], ['RTX 3080 12 GB', 12, 912],
    ['RTX 3080 10 GB', 10, 760], ['RTX 3070 Ti', 8, 608], ['RTX 3070', 8, 448], ['RTX 3060 Ti', 8, 448],
    ['RTX 3060 12 GB', 12, 360], ['RTX 2080 Ti', 11, 616], ['RTX 2060 12 GB', 12, 336],
  ] },
  { group: 'NVIDIA laptop GPUs', items: [
    ['RTX 5090 Laptop', 24, 896], ['RTX 5080 Laptop', 16, 896], ['RTX 4090 Laptop', 16, 576], ['RTX 4080 Laptop', 12, 432],
    ['RTX 4070 Laptop', 8, 256], ['RTX 4060 Laptop', 8, 256], ['RTX 3080 Ti Laptop', 16, 512],
  ] },
  { group: 'NVIDIA workstation', items: [
    ['RTX PRO 6000 Blackwell', 96, 1792], ['RTX PRO 5000 Blackwell', 48, 1344], ['RTX 6000 Ada', 48, 960],
    ['RTX 5000 Ada', 32, 576], ['RTX 4500 Ada', 24, 432], ['RTX 4000 Ada', 20, 360], ['RTX A6000', 48, 768],
    ['RTX A5000', 24, 768], ['RTX A4000', 16, 448],
  ] },
  { group: 'NVIDIA data centre', items: [
    ['B200', 192, 8000], ['H200', 141, 4800], ['GH200', 96, 4000], ['H100 SXM', 80, 3350], ['H100 PCIe', 80, 2000],
    ['A100 80 GB', 80, 2039], ['A100 40 GB', 40, 1555], ['L40S', 48, 864], ['A10', 24, 600], ['L4', 24, 300], ['T4', 16, 320],
  ] },
  { group: 'AMD Radeon / Instinct', items: [
    ['Radeon RX 9070 XT', 16, 640], ['Radeon RX 9070', 16, 640], ['Radeon RX 7900 XTX', 24, 960], ['Radeon RX 7900 XT', 20, 800],
    ['Radeon RX 7900 GRE', 16, 576], ['Radeon RX 7800 XT', 16, 624], ['Radeon RX 7600 XT', 16, 288], ['Radeon RX 7600', 8, 288],
    ['Radeon PRO W7900', 48, 864], ['Instinct MI300X', 192, 5300], ['Instinct MI325X', 256, 6000],
  ] },
  { group: 'Intel Arc', items: [
    ['Arc Pro B60', 24, 456], ['Arc B580', 12, 456], ['Arc A770 16 GB', 16, 560],
  ] },
].map((g) => ({ ...g, items: g.items.map(([name, mem, bw]) => ({ id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name, mem, bw })) }));

/** Unified-memory machines: CPU and GPU share one pool. `usable` is how much a model can realistically get. */
export const UNIFIED = [
  { id: 'dgx-spark', name: 'NVIDIA DGX Spark (GB10, 128 GB)', mem: 128, usable: 119, bw: 273, note: 'Also ASUS Ascent GX10, Dell Pro Max GB10, HP ZGX Nano, Lenovo ThinkStation PGX, MSI EdgeXpert. Two units can be linked for ~240 GB.', cluster: 2 },
  { id: 'dgx-station', name: 'NVIDIA DGX Station (GB300)', mem: 288, usable: 270, bw: 8000, note: '288 GB of HBM3e on the GPU (plus slower LPDDR5X for the CPU).' },
  { id: 'jetson-thor', name: 'NVIDIA Jetson AGX Thor (128 GB)', mem: 128, usable: 110, bw: 273, note: 'Robotics / edge module.' },
  { id: 'jetson-orin-64', name: 'NVIDIA Jetson AGX Orin (64 GB)', mem: 64, usable: 52, bw: 204, note: 'Edge module.' },
  { id: 'jetson-orin-nano', name: 'NVIDIA Jetson Orin Nano Super (8 GB)', mem: 8, usable: 5.5, bw: 102, note: 'Small edge board: stick to models under ~4B.' },
  { id: 'strix-halo-128', name: 'AMD Ryzen AI Max+ 395 (128 GB)', mem: 128, usable: 110, bw: 256, note: 'Framework Desktop, GMKtec EVO-X2, ASUS ROG Flow Z13 and others. Up to ~110 GB can be given to the GPU on Linux (96 GB on Windows).' },
  { id: 'strix-halo-64', name: 'AMD Ryzen AI Max (64 GB)', mem: 64, usable: 48, bw: 256, note: 'Up to 48 GB can be assigned to the GPU.' },
];

/** Apple Silicon chips: bandwidth and the memory sizes they were sold with. */
export const MAC_CHIPS = [
  ['M1', 68, [8, 16]], ['M1 Pro', 200, [16, 32]], ['M1 Max', 400, [32, 64]], ['M1 Ultra', 800, [64, 128]],
  ['M2', 100, [8, 16, 24]], ['M2 Pro', 200, [16, 32]], ['M2 Max', 400, [32, 64, 96]], ['M2 Ultra', 800, [64, 128, 192]],
  ['M3', 100, [8, 16, 24]], ['M3 Pro', 150, [18, 36]], ['M3 Max', 400, [36, 48, 64, 96, 128]], ['M3 Ultra', 819, [96, 256, 512]],
  ['M4', 120, [16, 24, 32]], ['M4 Pro', 273, [24, 48, 64]], ['M4 Max', 546, [36, 48, 64, 128]],
  ['M5', 153, [16, 24, 32]],
].map(([name, bw, sizes]) => ({ id: name.toLowerCase().replace(/\s+/g, '-'), name, bw, sizes }));

/** System RAM bandwidth for CPU-only inference (or the part of a model that overflows to RAM). */
export const CPU_MEMORY = [
  { id: 'ddr4', name: 'Desktop / laptop, DDR4', bw: 45 },
  { id: 'ddr5', name: 'Desktop / laptop, DDR5', bw: 80 },
  { id: 'lpddr5x', name: 'Thin laptop, LPDDR5X', bw: 110 },
  { id: 'hedt', name: 'Workstation, 4–8 channels (Threadripper / Xeon W)', bw: 250 },
  { id: 'server', name: 'Server, 12 channels (EPYC / Xeon)', bw: 450 },
];
export const RAM_SIZES = [8, 16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512, 768, 1024];

/** One-click starting points. */
export const PRESETS = [
  { label: 'Gaming PC · RTX 4070', state: { hw: 'gpu', gpu: 'rtx-4070', ngpu: 1, ram: 32, cpuMem: 'ddr5' } },
  { label: 'RTX 4090 workstation', state: { hw: 'gpu', gpu: 'rtx-4090', ngpu: 1, ram: 64, cpuMem: 'ddr5' } },
  { label: 'RTX 5090', state: { hw: 'gpu', gpu: 'rtx-5090', ngpu: 1, ram: 64, cpuMem: 'ddr5' } },
  { label: '2× RTX 3090 rig', state: { hw: 'gpu', gpu: 'rtx-3090', ngpu: 2, ram: 64, cpuMem: 'ddr4' } },
  { label: 'NVIDIA DGX Spark', state: { hw: 'unified', unified: 'dgx-spark', nunits: 1 } },
  { label: 'Ryzen AI Max+ 395 128 GB', state: { hw: 'unified', unified: 'strix-halo-128', nunits: 1 } },
  { label: 'MacBook Air M4 · 16 GB', state: { hw: 'mac', chip: 'm4', mac: 16 } },
  { label: 'MacBook Pro M4 Max · 64 GB', state: { hw: 'mac', chip: 'm4-max', mac: 64 } },
  { label: 'Mac Studio M3 Ultra · 512 GB', state: { hw: 'mac', chip: 'm3-ultra', mac: 512 } },
  { label: 'Laptop, no GPU · 16 GB', state: { hw: 'cpu', ram: 16, cpuMem: 'ddr5' } },
  { label: '8× H100 server', state: { hw: 'gpu', gpu: 'h100-sxm', ngpu: 8, ram: 1024, cpuMem: 'server', runtime: 'vllm' } },
];

export const allGpus = () => GPUS.flatMap((g) => g.items);
export const gpuById = (id) => allGpus().find((g) => g.id === id);
