# 第三方组件与内容声明

## Ruffle（vendor/ruffle）

本仓库内的 `vendor/ruffle/` 是 [Ruffle](https://github.com/ruffle-rs/ruffle) 的发布构建产物
（`ruffle.js`、`core.ruffle.*.js`、`*.wasm`），未做修改。

Ruffle 以 MIT 或 Apache-2.0 双许可发布，本项目按 MIT 分发其构建产物：

```
MIT License

Copyright (c) 2020-2026 Ruffle LLC and Ruffle contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 《洛克王国》游戏内容

剧情文本、美术、音乐、SWF 的著作权归腾讯公司及《洛克王国》项目组所有。
本仓库**不托管**任何官方美术 / 音频 / SWF 资源，运行时按官方脚本中的路径从
`res.17roco.qq.com` 读取，读取行为等同于用户自己的浏览器访问官网。

`data/` 下的 JSON 与 `data/ats/` 下的 XML 是播放器运行所需的索引与剧本文本，
由官方脚本解析而来，仅用于在本地复现剧情顺序。若版权方认为不妥，提交 issue 即可删除。
