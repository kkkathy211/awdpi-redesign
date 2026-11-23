// The "同步到官网" bookmark. The install page (index.mjs) drops these comment lines, joins the rest into one line,
// puts the API address in place of __ENDPOINT__ and offers it as a javascript: link.
// Every statement ends with a semicolon and there are no other comments, so joining the lines is safe.
// It reads the article that is open in the browser and posts it to the internal form, which opens in the same tab.
(function () {
  var E = "__ENDPOINT__";
  var c = document.getElementById("js_content");
  if (location.hostname !== "mp.weixin.qq.com" || !c) {
    alert("请先在电脑浏览器里打开一篇公众号文章，等文章显示出来，再点这个书签。");
    return;
  }
  var w = window, d = w.cgiDataNew || {};
  var p = function () {
    for (var i = 0; i < arguments.length; i++) {
      var v = arguments[i];
      if (v !== undefined && v !== null && v !== "") return String(v);
    }
    return "";
  };
  var t = function (id) {
    var e = document.getElementById(id);
    return e ? e.innerText.trim() : "";
  };
  var m = document.querySelector('meta[property="og:image"]');
  var s = document.querySelector("#js_share_source, #js_share_notice, .share_notice");
  var q = new URLSearchParams(location.search);
  var data = {
    v: 1,
    url: location.href,
    link: p(w.msg_link, d.link),
    biz: p(w.biz, q.get("__biz"), d.bizuin ? btoa(String(d.bizuin)) : ""),
    mid: p(w.mid, q.get("mid"), d.mid),
    idx: p(w.idx, q.get("idx"), d.idx),
    title: p(t("activity-name"), w.msg_title, d.title),
    ct: p(w.ct, d.create_time, d.ori_create_time),
    cover: p(w.msg_cdn_url, d.cdn_url, m ? m.content : ""),
    desc: p(w.msg_desc, d.desc),
    account: p(w.nickname, d.nick_name),
    author: p(d.author, t("js_author_name")),
    copyright: p(w.copyright_stat, w._copyright_stat, d.copyright_info ? d.copyright_info.copyright_stat : ""),
    originalLabel: t("copyright_logo"),
    shareSource: s ? s.innerText.trim().slice(0, 200) : "",
    html: c.innerHTML
  };
  var f = document.createElement("form");
  f.method = "post";
  f.action = E + "/capture";
  f.enctype = "text/plain";
  f.acceptCharset = "utf-8";
  var i = document.createElement("input");
  i.type = "hidden";
  i.name = "payload";
  i.value = JSON.stringify(data);
  f.appendChild(i);
  document.body.appendChild(f);
  f.submit();
})();
