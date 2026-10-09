// 作物适宜区间（本函数目录内独立副本）。
// Edge Function 部署只打包单个函数目录，跨目录 import 会 TS2307，故各函数各自持有一份；
// 修改作物需同步：functions/report-tick/generator.ts、functions/update-block/crops.ts、src/lib/farm-service.ts。

export interface CropSpec {
  name: string;
  temp: [number, number];
  humid: [number, number];
}

export const CROPS: Record<string, CropSpec> = {
  corn: { name: "玉米", temp: [18, 30], humid: [55, 80] },
  rice: { name: "水稻", temp: [20, 33], humid: [70, 92] },
  wheat: { name: "小麦", temp: [12, 26], humid: [45, 70] },
  cotton: { name: "棉花", temp: [20, 32], humid: [50, 75] },
  cucumber: { name: "黄瓜", temp: [16, 30], humid: [60, 85] },
};
