// Lays out the band's own element trees the way the terminal does, for the
// handful of Box and Text props the band uses: rows and columns, margins,
// flexGrow, space-between, and Text that truncates with an ellipsis.
//
// A node lays out to { width, height, spans }, each span a run of text on one
// row at a column with its style; `Clawd` is a placeholder box of fixed size.

const kids = node => (node.props.children ?? []).filter(c => c !== null && c !== undefined && c !== false && c !== '')

function textSpans(node, style = {}) {
  const own = { ...style }
  for (const key of ['color', 'bold', 'dimColor', 'inverse']) if (node.props[key] !== undefined) own[key] = node.props[key]
  return kids(node).flatMap(child => (typeof child === 'object' ? textSpans(child, own) : [{ text: String(child), style: own }]))
}

function layoutText(node, width) {
  const rows = [[]]
  for (const { text, style } of textSpans(node)) {
    text.split('\n').forEach((part, i) => {
      if (i > 0) rows.push([])
      if (part) rows.at(-1).push({ text: part, style })
    })
  }
  const spans = []
  let widest = 0
  rows.forEach((row, y) => {
    let x = 0
    for (const { text, style } of row) {
      let shown = text
      if (width !== undefined && x + shown.length > width) shown = shown.slice(0, Math.max(0, width - x - 1)) + '…'
      if (shown) spans.push({ x, y, text: shown, style })
      x += shown.length
      if (width !== undefined && x >= width) break
    }
    widest = Math.max(widest, x)
  })
  return { width: width ?? widest, height: rows.length, spans }
}

const shift = (spans, dx, dy) => spans.map(s => ({ ...s, x: s.x + dx, y: s.y + dy }))

export function layout(node, width) {
  if (typeof node !== 'object') return layoutText({ props: { children: [node] } }, width)
  if (node.type === 'Clawd') return { width: node.props.width, height: node.props.height, spans: [], clawd: [{ x: 0, y: 0 }] }
  if (node.type === 'Text') return layoutText(node, width)

  const p = node.props
  if (typeof p.width === 'number') width = width === undefined ? p.width : Math.min(width, p.width)
  const children = kids(node)
  const margin = c => (typeof c === 'object' ? (c.props.marginLeft ?? 0) + (c.props.marginRight ?? 0) : 0)
  if ((p.flexDirection ?? 'row') === 'column') {
    let y = 0
    let widest = 0
    const spans = []
    const clawd = []
    for (const child of children) {
      const box = layout(child, width)
      spans.push(...shift(box.spans, child.props?.marginLeft ?? 0, y))
      clawd.push(...(box.clawd ?? []).map(c => ({ x: c.x, y: c.y + y })))
      y += box.height
      widest = Math.max(widest, box.width + margin(child))
    }
    return { width: width ?? widest, height: y, spans, clawd }
  }

  // A row: fixed children first, then the one that grows takes what's left.
  const sized = children.map(child => (typeof child === 'object' && child.props.flexGrow ? null : layout(child)))
  const used = sized.reduce((sum, box, i) => sum + (box ? box.width : 0) + margin(children[i]), 0)
  const boxes = sized.map((box, i) => box ?? layout(children[i], Math.max(0, (width ?? used) - used - margin(children[i]))))
  const total = boxes.reduce((sum, box, i) => sum + box.width + margin(children[i]), 0)
  const gap = p.justifyContent === 'space-between' && width !== undefined && boxes.length > 1 ? (width - total) / (boxes.length - 1) : 0
  let x = 0
  const spans = []
  const clawd = []
  boxes.forEach((box, i) => {
    const child = children[i]
    x += typeof child === 'object' ? (child.props.marginLeft ?? 0) : 0
    spans.push(...shift(box.spans, Math.round(x), 0))
    clawd.push(...(box.clawd ?? []).map(c => ({ x: c.x + Math.round(x), y: c.y })))
    x += box.width + (typeof child === 'object' ? (child.props.marginRight ?? 0) : 0) + gap
  })
  return { width: width ?? total, height: Math.max(0, ...boxes.map(b => b.height)), spans, clawd }
}
