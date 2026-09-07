# 学术写作示例

## 文献与问题

本示例的文献集合包含三个 Zotero 条目 [@D9PGQUM4; @T4IQZGRM; @MRHTZ5CI]。这些键会按当前个人文献库中的元数据生成引文和文后列表。

下面的公式仅用于演示编号与交叉引用。能量关系见 \eqref{eq:energy}，归一化比值见 [@eq:ratio]。引用写在公式定义之前，也能定位到后文目标。

## 公式与推导

$$
E = mc^2 \label{eq:energy}
$$

定义行内比值 $\eta = E/E_0\label{eq:ratio}$。式 \ref{eq:energy} 中的 $E$ 与式 \ref{eq:ratio} 中的分子使用相同符号。

当参考质量为 $m_0$ 时，可以写出：

\[
E_0 = m_0 c^2
\] {#eq:reference}

将 \eqref{eq:energy} 与 \eqref{eq:reference} 代入 \eqref{eq:ratio}，得到下列简化结果。

```math {#eq:result}
\eta = \frac{m}{m_0}
```

## 讨论

同一条文献再次引用时使用相同的 Zotero 键 [@D9PGQUM4]。切换顺序编号和作者年份样式时，键保持不变。

最终关系为 \eqref{eq:result}。文后列表放在附录前；将下一行的占位符移动到其他位置即可调整列表位置。

<!-- markedown:bibliography -->

# 附录

## 符号说明

| 符号 | 含义 |
| --- | --- |
| $E$ | 能量 |
| $m$ | 质量 |
| $c$ | 光速 |
| $E_0$ | 参考能量 |
| $m_0$ | 参考质量 |
| $\eta$ | 归一化比值 |

正文中的 \eqref{eq:result} 也可从附录引用，标签不依赖章节中的当前位置。
