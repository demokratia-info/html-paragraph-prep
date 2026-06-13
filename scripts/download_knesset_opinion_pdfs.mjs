#!/usr/bin/env node
"use strict";

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ODATA_URL = "https://knesset.gov.il/Odata/ParliamentInfo.svc/KNS_DocumentBill";
const DEFAULT_OUTPUT_DIR = path.join(REPO_ROOT, "downloads", "knesset-opinion-pdfs");
const DEFAULT_PAGE_SIZE = 100;

const JUDICIAL_TERMS = [
  "הרפורמה המשפטית",
  "המהפכה המשפטית",
  "מערכת המשפט",
  "בתי המשפט",
  "בית המשפט",
  "השפיטה",
  "שופטים",
  "שופט",
  "הוועדה לבחירת שופטים",
  "ועדה לבחירת שופטים",
  "מינוי שופטים",
  "נציב תלונות הציבור על שופטים",
  "נציבות תלונות הציבור על שופטים",
  "יועץ המשפטי לממשלה",
  "היועץ המשפטי לממשלה",
  "היועצת המשפטית לממשלה",
  "התובע הכללי",
  "עילת הסבירות",
  "פסקת התגברות",
  "ביקורת שיפוטית",
  "נבצרות",
  "שומרי סף",
  "חוק יסוד: השפיטה",
  "חוק-יסוד: השפיטה"
];

const OPINION_TERMS = [
  "חוות דעת",
  "חוות-דעת",
  "חו\"ד",
  "חוו\"ד",
  "נייר עמדה",
  "מסמך עמדה",
  "עמדה",
  "עמדת",
  "עמדה מטעם",
  "התייחסות",
  "פנייה",
  "מכתב",
  "opinion",
  "position paper"
];

const STRICT_OPINION_TERMS = [
  "חוות דעת",
  "חוות-דעת",
  "חו\"ד",
  "חוו\"ד"
];

const PRO_LIBERAL_TERMS = [
  "דמוקרט",
  "ליברל",
  "שלטון החוק",
  "הפרדת רשויות",
  "איזונים ובלמים",
  "עצמאות מערכת המשפט",
  "עצמאות שיפוטית",
  "עצמאות השפיטה",
  "עצמאות שומרי הסף",
  "שומרי סף בלתי תלויים",
  "זכויות אדם",
  "זכויות יסוד",
  "זכויות הפרט",
  "פגיעה בדמוקרטיה",
  "פגיעה בשלטון החוק",
  "מינהל תקין",
  "מנהל תקין",
  "הגנה על זכויות",
  "אמון הציבור"
];

const PRO_LIBERAL_ORGS = [
  "האגודה לזכויות האזרח",
  "התנועה למען איכות השלטון",
  "המכון הישראלי לדמוקרטיה",
  "המרכז הרפורמי לדת ומדינה",
  "פורום ההייטק למען ישראל",
  "לשכת עורכי הדין",
  "דרכנו",
  "מחאת ההייטק",
  "משמר הדמוקרטיה",
  "זולת"
];

const EXCLUDED_ORGS = [
  "פורום קהלת",
  "קהלת",
  "חוננו",
  "פורום תקווה",
  "בצלמו",
  "אם תרצו",
  "המטה למען ארץ ישראל",
  "הפורום המשפטי למען ארץ ישראל",
  "פורום משפטי למען ארץ ישראל",
  "התנועה למשילות ודמוקרטיה",
  "רגבים",
  "לביא",
  "תורת לחימה",
  "עד כאן",
  "ישראל שלי"
];

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  ensureCommand("pdftotext");

  const paths = buildOutputPaths(options.outputDir);
  ensureDir(paths.outputDir);
  ensureDir(paths.pdfDir);
  ensureDir(paths.cachePdfDir);
  ensureDir(paths.textDir);

  console.log(`Fetching Knesset ${options.knesset} PDF metadata...`);
  const documents = await fetchAllDocuments(options);
  console.log(`Metadata rows: ${documents.length}`);

  const metadataCandidates = documents
    .filter((doc) => options.scanAllBackground || termMatches(metadataText(doc), JUDICIAL_TERMS).length)
    .slice(0, options.limit ?? documents.length);

  console.log(`PDFs selected for text scan: ${metadataCandidates.length}`);
  if (options.dryRun) {
    writeCsv(paths.candidatesCsv, metadataCandidates.map((doc) => candidateRow(doc)));
    console.log(`Dry run wrote ${paths.candidatesCsv}`);
    return;
  }

  emptyDir(paths.pdfDir);

  const accepted = [];
  const rejected = [];

  for (let index = 0; index < metadataCandidates.length; index += 1) {
    const doc = metadataCandidates[index];
    const filename = localPdfFilename(doc);
    const cachePdfPath = path.join(paths.cachePdfDir, filename);
    const acceptedPdfPath = path.join(paths.pdfDir, filename);
    const textPath = path.join(paths.textDir, `${path.basename(filename, ".pdf")}.txt`);

    process.stdout.write(`[${index + 1}/${metadataCandidates.length}] ${filename} ... `);
    try {
      await downloadPdf(doc.FilePath, cachePdfPath);
      const text = extractPdfText(cachePdfPath, textPath);
      const analysis = analyzeDocument(doc, text, options);
      const row = resultRow(doc, filename, analysis.accepted ? acceptedPdfPath : "", analysis);
      if (analysis.accepted) {
        fs.copyFileSync(cachePdfPath, acceptedPdfPath);
        accepted.push(row);
        console.log("accepted");
      } else {
        rejected.push(row);
        console.log("rejected");
      }
    } catch (error) {
      rejected.push(resultRow(doc, filename, "", {
        accepted: false,
        reason: `error: ${error.message || error}`,
        opinionTerms: [],
        judicialTerms: termMatches(metadataText(doc), JUDICIAL_TERMS),
        liberalTerms: [],
        liberalOrgs: [],
        excludedOrgs: []
      }));
      console.log(`error: ${error.message || error}`);
    }
  }

  writeCsv(paths.acceptedCsv, accepted);
  writeCsv(paths.rejectedCsv, rejected);
  writeCsv(paths.candidatesCsv, metadataCandidates.map((doc) => candidateRow(doc)));

  console.log("");
  console.log(`Accepted PDFs: ${accepted.length}`);
  console.log(`Downloaded PDFs: ${paths.pdfDir}`);
  console.log(`CSV: ${paths.acceptedCsv}`);
  console.log(`Rejected audit CSV: ${paths.rejectedCsv}`);
}

function parseArgs(args) {
  const options = {
    knesset: 25,
    outputDir: DEFAULT_OUTPUT_DIR,
    pageSize: DEFAULT_PAGE_SIZE,
    scanAllBackground: false,
    allPdfGroups: false,
    includeExcluded: false,
    strictOpinion: false,
    dryRun: false,
    limit: null,
    help: false
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--scan-all-background") options.scanAllBackground = true;
    else if (arg === "--all-pdf-groups") options.allPdfGroups = true;
    else if (arg === "--include-excluded") options.includeExcluded = true;
    else if (arg === "--strict-opinion") options.strictOpinion = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--knesset") options.knesset = Number(readValue(args, ++i, arg));
    else if (arg === "--output-dir") options.outputDir = path.resolve(readValue(args, ++i, arg));
    else if (arg === "--page-size") options.pageSize = Number(readValue(args, ++i, arg));
    else if (arg === "--limit") options.limit = Number(readValue(args, ++i, arg));
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isInteger(options.knesset) || options.knesset < 1) {
    throw new Error("--knesset must be a positive integer.");
  }
  if (!Number.isInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 100) {
    throw new Error("--page-size must be an integer from 1 to 100.");
  }
  if (options.limit !== null && (!Number.isInteger(options.limit) || options.limit < 1)) {
    throw new Error("--limit must be a positive integer.");
  }
  return options;
}

function readValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value.`);
  return value;
}

function printHelp() {
  console.log(`Usage:
  node scripts/download_knesset_opinion_pdfs.mjs [options]

Options:
  --output-dir DIR          Output directory. Default: downloads/knesset-opinion-pdfs
  --knesset NUM            Knesset number. Default: 25
  --limit NUM              Scan only the first NUM metadata candidates.
  --dry-run                Fetch metadata and write candidate CSV without downloading PDFs.
  --scan-all-background    Download/text-scan every background PDF, not only judicial-title matches.
  --all-pdf-groups         Include every PDF group, not only "חומר רקע".
  --strict-opinion         Require literal חוות דעת / חו"ד instead of broader opinion/background signals.
  --include-excluded       Keep documents from excluded anti-liberal organizations if other terms match.
`);
}

async function fetchAllDocuments(options) {
  const documents = [];
  for (let skip = 0; ; skip += options.pageSize) {
    const page = await fetchDocumentPage(skip, options);
    documents.push(...page);
    if (page.length < options.pageSize) break;
  }
  return documents;
}

async function fetchDocumentPage(skip, options) {
  const params = new URLSearchParams();
  params.set("$format", "json");
  params.set("$top", String(options.pageSize));
  params.set("$skip", String(skip));
  params.set("$orderby", "DocumentBillID desc");
  params.set("$expand", "KNS_Bill");
  params.set("$filter", documentFilter(options));

  const response = await fetch(`${ODATA_URL}?${params.toString()}`, {
    headers: { "Accept": "application/json" }
  });
  if (!response.ok) {
    throw new Error(`Knesset OData returned ${response.status}: ${await response.text()}`);
  }
  const data = await response.json();
  return Array.isArray(data.value) ? data.value : [];
}

function documentFilter(options) {
  const filters = [
    `KNS_Bill/KnessetNum eq ${options.knesset}`,
    "ApplicationDesc eq 'PDF'"
  ];
  if (!options.allPdfGroups) {
    filters.push("GroupTypeDesc eq 'חומר רקע'");
  }
  return filters.join(" and ");
}

function metadataText(doc) {
  return [
    doc.KNS_Bill?.Name,
    doc.KNS_Bill?.SummaryLaw,
    doc.GroupTypeDesc,
    doc.FilePath
  ].filter(Boolean).join("\n");
}

function analyzeDocument(doc, text, options) {
  const haystack = normalizeText(`${metadataText(doc)}\n${text}`);
  const opinionTerms = termMatches(haystack, options.strictOpinion ? STRICT_OPINION_TERMS : OPINION_TERMS);
  const judicialTerms = termMatches(haystack, JUDICIAL_TERMS);
  const liberalTerms = termMatches(haystack, PRO_LIBERAL_TERMS);
  const liberalOrgs = termMatches(haystack, PRO_LIBERAL_ORGS);
  const excludedOrgs = termMatches(haystack, EXCLUDED_ORGS);

  const hasOpinionSignal = opinionTerms.length > 0
    || (!options.strictOpinion && normalizeText(doc.GroupTypeDesc) === normalizeText("חומר רקע"));
  const hasJudicialSignal = judicialTerms.length > 0;
  const hasLiberalSignal = liberalTerms.length > 0 || liberalOrgs.length > 0;
  const hasExcludedOrg = excludedOrgs.length > 0;
  const accepted = hasOpinionSignal
    && hasJudicialSignal
    && hasLiberalSignal
    && (options.includeExcluded || !hasExcludedOrg);

  const missing = [];
  if (!hasOpinionSignal) {
    missing.push(options.strictOpinion ? "missing strict opinion term" : "missing opinion/background signal");
  }
  if (!hasJudicialSignal) missing.push("missing judicial-reform term");
  if (!hasLiberalSignal) missing.push("missing pro-liberal/pro-democratic signal");
  if (hasExcludedOrg && !options.includeExcluded) missing.push(`excluded org: ${excludedOrgs.join("; ")}`);

  return {
    accepted,
    reason: accepted ? "matched opinion + judicial + liberal filters" : missing.join("; "),
    opinionTerms,
    judicialTerms,
    liberalTerms,
    liberalOrgs,
    excludedOrgs
  };
}

function termMatches(text, terms) {
  const haystack = normalizeText(text);
  const matches = [];
  for (const term of terms) {
    if (haystack.includes(normalizeText(term))) matches.push(term);
  }
  return matches;
}

function normalizeText(value) {
  return String(value || "")
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/[״”]/g, "\"")
    .replace(/[׳’]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

async function downloadPdf(url, outputPath) {
  if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) return;
  const response = await fetch(normalizeKnessetFileUrl(url), {
    headers: { "Accept": "application/pdf,*/*" }
  });
  if (!response.ok) throw new Error(`download failed ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.subarray(0, 4).equals(Buffer.from("%PDF"))) {
    throw new Error("download did not return a PDF");
  }
  fs.writeFileSync(outputPath, buffer);
}

function extractPdfText(pdfPath, textPath) {
  if (fs.existsSync(textPath) && fs.statSync(textPath).size > 0) {
    return fs.readFileSync(textPath, "utf8");
  }
  const result = spawnSync("pdftotext", ["-layout", "-enc", "UTF-8", pdfPath, "-"], {
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || "pdftotext failed").trim());
  }
  fs.writeFileSync(textPath, result.stdout || "", "utf8");
  return result.stdout || "";
}

function resultRow(doc, filename, pdfPath, analysis) {
  return {
    filename,
    url: normalizeKnessetFileUrl(doc.FilePath),
    local_path: pdfPath ? path.relative(REPO_ROOT, pdfPath) : "",
    bill_name: doc.KNS_Bill?.Name || "",
    bill_id: doc.BillID || "",
    document_bill_id: doc.DocumentBillID || "",
    group_type: doc.GroupTypeDesc || "",
    last_updated: doc.LastUpdatedDate || "",
    accepted: analysis.accepted ? "yes" : "no",
    reason: analysis.reason || "",
    opinion_terms: analysis.opinionTerms.join("; "),
    judicial_terms: analysis.judicialTerms.join("; "),
    liberal_terms: analysis.liberalTerms.join("; "),
    liberal_orgs: analysis.liberalOrgs.join("; "),
    excluded_orgs: analysis.excludedOrgs.join("; ")
  };
}

function candidateRow(doc) {
  return {
    filename: localPdfFilename(doc),
    url: normalizeKnessetFileUrl(doc.FilePath),
    bill_name: doc.KNS_Bill?.Name || "",
    bill_id: doc.BillID || "",
    document_bill_id: doc.DocumentBillID || "",
    group_type: doc.GroupTypeDesc || "",
    last_updated: doc.LastUpdatedDate || "",
    metadata_judicial_terms: termMatches(metadataText(doc), JUDICIAL_TERMS).join("; ")
  };
}

function localPdfFilename(doc) {
  const url = normalizeKnessetFileUrl(doc.FilePath);
  const basename = safeFilename(path.basename(new URL(url).pathname) || `${doc.DocumentBillID}.pdf`);
  return `${doc.DocumentBillID}-${basename.endsWith(".pdf") ? basename : `${basename}.pdf`}`;
}

function normalizeKnessetFileUrl(url) {
  const parsed = new URL(String(url || "").replace("https://fs.knesset.gov.il//", "https://fs.knesset.gov.il/"));
  parsed.protocol = "https:";
  return parsed.href;
}

function safeFilename(value) {
  return String(value || "document.pdf")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "document.pdf";
}

function writeCsv(filePath, rows) {
  const columns = rows.length ? Object.keys(rows[0]) : [
    "filename",
    "url",
    "local_path",
    "bill_name",
    "bill_id",
    "document_bill_id",
    "group_type",
    "last_updated",
    "accepted",
    "reason",
    "opinion_terms",
    "judicial_terms",
    "liberal_terms",
    "liberal_orgs",
    "excluded_orgs"
  ];
  const lines = [
    columns.join(","),
    ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(","))
  ];
  fs.writeFileSync(filePath, `\ufeff${lines.join("\n")}\n`, "utf8");
}

function csvCell(value) {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, "\"\"")}"`;
}

function buildOutputPaths(outputDir) {
  return {
    outputDir,
    pdfDir: path.join(outputDir, "pdfs"),
    cachePdfDir: path.join(outputDir, "pdf-cache"),
    textDir: path.join(outputDir, "text-cache"),
    acceptedCsv: path.join(outputDir, "knesset_opinion_pdfs.csv"),
    rejectedCsv: path.join(outputDir, "rejected_candidates.csv"),
    candidatesCsv: path.join(outputDir, "metadata_candidates.csv")
  };
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function emptyDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  ensureDir(dir);
}

function ensureCommand(command) {
  const result = spawnSync("bash", ["-lc", `command -v ${command}`], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} is required but was not found on PATH.`);
  }
}
