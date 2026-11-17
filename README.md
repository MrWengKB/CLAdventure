# 文字探险

一个在浏览器中运行的文字冒险小游戏。

## 运行

浏览器直接双击打开 `index.html` 无法读取 CSV，请在项目目录启动一个本地服务器：

```bash
python3 -m http.server 8000
```

然后访问 http://localhost:8000 。也可以直接用 GitHub Pages 部署。

## 规则

- 初始：生命 10（上限 10）、金币 200、经验 0。
- 每开启新的一天，需要答对一道随机问题（`questions.csv`，四选一，选项顺序随机）。答错会显示正确答案，并换一道题重试，没有惩罚。
- 新的一天触发一个随机事件（`event.csv`），数值为增减量；`full` 表示回满生命。
- 生命不超过上限、不低于 0；金币可以为负（负债）；经验只增不减。
- 生命为 0 则游戏失败；坚持满 30 天且生命大于 0 则通关。

## 数据文件

- `questions.csv`：`Question,Answer,Distractor1,Distractor2,Distractor3`
- `event.csv`：`SN,event,life,coins,exp`
