# 第三方组件说明

为了让下载者**解压即可使用**、不必自己配置环境，免安装发布包（Releases 里的压缩包）
内置了下面两个第三方程序。Git 仓库的源代码里**不含**这些二进制文件。

---

## Node.js

- 版本：v24.21.0（Windows x64）
- 用途：运行本工具的本地服务
- 许可证：MIT
- 官网：<https://nodejs.org>
- 许可证全文见压缩包内 `bin/NODE-LICENSE.txt`

## FFmpeg

- 版本：7.1（gyan.dev essentials build，Windows x64）
- 用途：把浏览器逐帧渲染出的画面编码成带透明通道的视频
- 许可证：GPL v3（该构建启用了 libx264 等 GPL 组件）
- 构建来源：<https://www.gyan.dev/ffmpeg/builds/>
- 对应源代码：<https://git.ffmpeg.org/ffmpeg.git>（标签 `n7.1`）
- 许可证全文：<https://www.gnu.org/licenses/gpl-3.0.html>

FFmpeg 是独立的命令行程序，本工具只是调用它，二者不是同一个作品。
如果再分发本发布包，请一并保留本说明与上述许可证文本。
