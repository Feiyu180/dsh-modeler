/**
 * gen-mc-tables.py —— 已作废。
 *
 * 原计划生成 Marching Cubes 的 edgeTable / triTable（各 256 项）。
 * 实测：凭记忆手抄这两张表会引入无法用肉眼发现的拓扑错误（三角形不闭合、
 * 绕序不一致），而错误要到"导出 STL 后切片出现破洞"才暴露。
 *
 * 改用 **Naive Surface Nets**（对偶等值面）：每个跨越表面的体素格生成 1 个顶点，
 * 每条变号格边生成 1 个四边形。它不需要任何查找表 —— 拓扑由"每个变号格边恰好
 * 对应 4 个变号格"这一几何事实保证，因此网格必然闭合、必然流形、绕序可自动判定。
 * 详见 src/core/mesher.js。
 *
 * 本文件保留仅为记录这次取舍，不再参与构建。
 */
console.log('deprecated: see src/core/mesher.js (Naive Surface Nets)')
