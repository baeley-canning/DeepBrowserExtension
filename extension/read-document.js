/**
 * Read an attached job description into text, entirely in the browser.
 *
 * The extension is standalone — there is no server to post a file to — so PDF
 * parsing happens here with a vendored pdf.js. That is 2MB of dependency, which
 * is a lot, but the alternative is telling a recruiter holding a PDF to go and
 * retype it.
 *
 * Nothing is uploaded anywhere. The file is read, turned into text, and the
 * text goes into the message you send.
 */

/**
 * Lazily set up pdf.js — 2MB should not load unless a PDF is actually attached.
 *
 * It MUST be injected as a classic <script>, not `import()`ed. The vendored
 * build is UMD: it assigns `this.pdfjsLib = factory()`, and in an ES module
 * `this` is undefined at top level, so importing it throws
 * "Cannot set properties of undefined (setting 'pdfjsLib')". A script tag runs
 * in classic scope where `this` is the window, which is what it expects.
 */
let pdfjsReady = null;
async function getPdfjs() {
  if (pdfjsReady) return pdfjsReady;
  pdfjsReady = (async () => {
    if (!globalThis.pdfjsLib) {
      await new Promise((resolve, reject) => {
        const tag = document.createElement("script");
        tag.src = chrome.runtime.getURL("vendor/pdf.js");
        tag.onload = resolve;
        tag.onerror = () => reject(new Error("pdf.js failed to load from the extension bundle"));
        document.head.appendChild(tag);
      });
    }
    const lib = globalThis.pdfjsLib;
    if (!lib) throw new Error("pdf.js loaded but did not register itself");
    lib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdf.worker.js");
    return lib;
  })();
  return pdfjsReady;
}

async function readPdf(file) {
  const pdfjs = await getPdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    // pdf.js gives positioned fragments, not lines. Join on the same y so a
    // JD's bullet points don't collapse into one run-on paragraph.
    let line = [];
    let lastY = null;
    const out = [];
    for (const item of content.items) {
      const y = Math.round(item.transform?.[5] ?? 0);
      if (lastY !== null && Math.abs(y - lastY) > 2) {
        out.push(line.join("").trim());
        line = [];
      }
      line.push(item.str);
      lastY = y;
    }
    if (line.length) out.push(line.join("").trim());
    pages.push(out.filter(Boolean).join("\n"));
  }
  return pages.join("\n\n");
}

/**
 * @param {File} file
 * @returns {Promise<{name:string, text:string, truncated:boolean}>}
 */
export async function readDocument(file, maxChars = 40000) {
  const name = file.name || "document";
  const lower = name.toLowerCase();
  let text = "";

  if (lower.endsWith(".pdf") || file.type === "application/pdf") {
    text = await readPdf(file);
  } else if (lower.endsWith(".doc")) {
    // Legacy binary .doc is a different format entirely; reading it as text
    // yields mojibake. Say so rather than handing the model garbage.
    throw new Error("Old .doc files aren't supported — save it as PDF or .txt, or paste the text.");
  } else if (lower.endsWith(".docx")) {
    throw new Error(".docx isn't supported yet — save it as PDF or .txt, or paste the text.");
  } else {
    text = await file.text();
  }

  text = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  if (!text) {
    // A scan is images with no text layer. Common, and it must not look like
    // the feature is simply broken.
    throw new Error(
      "No text could be read from that file. If it's a scan or an image-only PDF there is no " +
        "text layer to extract — paste the text instead.",
    );
  }

  const truncated = text.length > maxChars;
  return { name, text: truncated ? text.slice(0, maxChars) : text, truncated };
}
