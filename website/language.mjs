const localeKey = "opendirector.website.locale";
const links = new Map([...document.querySelectorAll("a[data-lang]")].map(link => [link.dataset.lang, link]));

for (const [locale, link] of links) {
  link.addEventListener("click", () => {
    try { localStorage.setItem(localeKey, locale); } catch {}
  });
}

if (document.documentElement.hasAttribute("data-language-entry")) {
  let locale = /^zh(?:-|$)/i.test(navigator.language) ? "zh-CN" : "en-US";
  try {
    const saved = localStorage.getItem(localeKey);
    if (links.has(saved)) locale = saved;
  } catch {}

  const destination = new URL(links.get(locale).href);
  destination.search = location.search;
  destination.hash = location.hash;
  location.replace(destination.href);
}
