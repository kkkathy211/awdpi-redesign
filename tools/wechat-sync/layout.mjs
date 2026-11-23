// Layout fixes for WeChat markup shown on the website's wider page. Used by import.mjs.
//
// WeChat layouts are made for a phone screen. Two things break when the page is wider:
// 1. WeChat's script replaces an image's own width (often a percentage) with the pixel width it measured on the
//    editor's screen. The editor's own style is kept in data-original-style, so put it back.
// 2. Image-and-text rows often let the image hang below its column with a negative bottom margin. On a phone
//    the text column beside it is taller, so nothing happens; on a wider page the text needs fewer lines, the row
//    gets shorter and the image covers the next paragraph. When nothing follows that block inside its column,
//    the margin only shrinks the row, so it is set to 0. Only blocks with an image that hang by 10px or more:
//    small negative margins are used to join decorative lines and are left alone.

function declarations(style) {
  return String(style || "")
    .split(";")
    .map((d) => d.split(":"))
    .filter((p) => p.length >= 2)
    .map(([prop, ...rest]) => [prop.trim().toLowerCase(), rest.join(":").replace(/!important/i, "").trim()]);
}

function bottomMargin(style) {
  let bottom = "";
  for (const [prop, value] of declarations(style)) {
    if (prop === "margin-bottom") bottom = value;
    else if (prop === "margin") {
      const t = value.split(/\s+/);
      bottom = t.length >= 3 ? t[2] : t[0];
    }
  }
  return bottom;
}

function isColumn($, node) {
  const own = Object.fromEntries(declarations(node.attr("style")));
  if (own.display === "inline-block" && /%$/.test(own.width || "") && parseFloat(own.width) < 100) return true;
  const parent = node.parent();
  if (!parent.length) return false;
  const p = Object.fromEntries(declarations(parent.attr("style")));
  const direction = p["flex-direction"] || p["flex-flow"] || "row";
  return /flex/.test(p.display || "") && !/^column/.test(direction);
}

export function fixLayout($, root) {
  let restored = 0, margins = 0;

  root.find("img[data-original-style]").each((_, el) => {
    const img = $(el);
    img.attr("style", img.attr("data-original-style"));
    img.removeAttr("data-original-style");
    restored++;
  });

  root.find("[style]").each((_, el) => {
    const node = $(el);
    const margin = bottomMargin(node.attr("style"));
    if (!/^-\d/.test(margin) || parseFloat(margin) > -10) return;
    const hasImage = node.is("img") || node.find("img").length > 0
      || /url\(/.test(node.attr("style")) || node.find("[style*='url(']").length > 0;
    if (!hasImage) return;
    for (let n = node; n.length && !n.is(root); n = n.parent()) {
      if (isColumn($, n)) {
        node.attr("style", `${node.attr("style").replace(/;?\s*$/, "")};margin-bottom: 0px`);
        margins++;
        return;
      }
      if (n.next().length) return; // something below slides under it on purpose
    }
  });

  return { restored, margins };
}
