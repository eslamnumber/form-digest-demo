/**
 * Form → Sheet → Daily Digest
 *
 * doPost           Receives form submissions from any website and appends them to the sheet.
 * sendDailyDigest  Emails ONE summary of the last 24 hours to all recipients. Skips empty days.
 * sendDigestNow    Manual test: runs the digest immediately.
 * setup            One-time setup (safe to rerun): header row, default settings, 8 AM trigger.
 *
 * Settings live in Script Properties (Project Settings → Script properties):
 *   RECIPIENTS  comma-separated digest recipients (default: the account that runs setup)
 *   SHEET_ID    spreadsheet that stores the entries (default: the sheet this script is bound to)
 *   SHEET_NAME  tab name (default: Entries)
 */

const HEADERS = ['timestamp', 'name', 'email', 'company', 'message', 'source'];
const REQUIRED_FIELDS = ['name', 'email', 'message'];
const MAX_LENGTH = { name: 100, email: 254, company: 100, message: 5000, source: 50 };
const HONEYPOT_FIELD = 'website';
const DIGEST_HOUR = 8;
const DIGEST_TIMEZONE = 'Asia/Karachi';
const DIGEST_TRIGGER_HANDLER = 'sendDailyDigest';
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DAY_MS = 24 * 60 * 60 * 1000;

// --- Web app -------------------------------------------------------------------------------

/**
 * Accepts URL-encoded or multipart (FormData) POSTs. These are "simple" CORS requests, so any
 * website can call the /exec URL without a preflight. Always answers with JSON.
 */
function doPost(e) {
  try {
    const params = (e && e.parameter) || {};
    if (String(params[HONEYPOT_FIELD] || '').trim()) {
      return json_({ ok: true }); // a bot filled the hidden field: pretend success, store nothing
    }

    const result = validateEntry_(params);
    if (result.error) {
      return json_({ ok: false, error: result.error });
    }

    const entry = result.entry;
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      getEntriesSheet_().appendRow(
        [new Date(), entry.name, entry.email, entry.company, entry.message, entry.source].map(asText_)
      );
    } finally {
      lock.releaseLock();
    }
    return json_({ ok: true });
  } catch (err) {
    console.error('doPost failed: ' + (err && err.stack ? err.stack : err));
    return json_({ ok: false, error: 'Your message could not be saved. Please try again later.' });
  }
}

/** Visiting the /exec URL in a browser shows that the endpoint is alive. */
function doGet() {
  return json_({ ok: true, message: 'Form endpoint is running. Submit entries with POST.' });
}

function validateEntry_(params) {
  const value = (key) => String(params[key] == null ? '' : params[key]).trim();
  const entry = {
    name: value('name'),
    email: value('email'),
    company: value('company'),
    message: value('message'),
    source: value('source').replace(/[^\w.-]/g, '').slice(0, MAX_LENGTH.source) || 'unknown',
  };

  const missing = REQUIRED_FIELDS.filter((key) => !entry[key]);
  if (missing.length) {
    return { error: 'Please fill in: ' + missing.join(', ') + '.' };
  }
  if (entry.email.length > MAX_LENGTH.email || !EMAIL_PATTERN.test(entry.email)) {
    return { error: 'Please enter a valid email address.' };
  }
  for (const key of ['name', 'company', 'message']) {
    if (entry[key].length > MAX_LENGTH[key]) {
      return { error: 'The ' + key + ' field is too long (max ' + MAX_LENGTH[key] + ' characters).' };
    }
  }
  return { entry: entry };
}

/**
 * Store text exactly as typed. Without the leading apostrophe Sheets would turn "=..." into a
 * formula (formula injection), "0300..." into a number and "1/2" into a date.
 */
function asText_(value) {
  return typeof value === 'string' && value !== '' ? "'" + value : value;
}

function json_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}

// --- Daily digest --------------------------------------------------------------------------

/**
 * Runs every morning at ~8:00 Asia/Karachi. Selects rows by timestamp (last 24 hours), not
 * "since last run", so a skipped or repeated run never loses or corrupts state.
 * Returns the number of entries emailed (0 = nothing sent).
 */
function sendDailyDigest() {
  const until = new Date();
  const since = new Date(until.getTime() - DAY_MS);
  const entries = getEntriesBetween_(since, until);
  if (!entries.length) {
    console.log('No entries between ' + formatTime_(since) + ' and ' + formatTime_(until) + '. No email sent.');
    return 0;
  }

  const recipients = getRecipients_();
  const sheetUrl = getSpreadsheet_().getUrl();
  const digest = buildDigest_(entries, since, until, sheetUrl);
  MailApp.sendEmail({
    to: recipients.join(','),
    subject: digest.subject,
    body: digest.text,
    htmlBody: digest.html,
    name: 'Form Digest',
  });
  console.log('Digest with ' + entries.length + ' entries sent to ' + recipients.join(', '));
  return entries.length;
}

/** Manual test: select this function in the editor and click Run. */
function sendDigestNow() {
  const count = sendDailyDigest();
  console.log(count ? 'Sent. Check the inbox of: ' + getRecipients_().join(', ') : 'Nothing to send: no entries in the last 24 hours.');
}

function getEntriesBetween_(since, until) {
  const sheet = getEntriesSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return [];
  }
  return sheet
    .getRange(2, 1, lastRow - 1, HEADERS.length)
    .getValues()
    .map((row) => ({
      timestamp: toDate_(row[0]),
      name: String(row[1]),
      email: String(row[2]),
      company: String(row[3]),
      message: String(row[4]),
      source: String(row[5]),
    }))
    .filter((entry) => entry.timestamp && entry.timestamp >= since && entry.timestamp <= until)
    .sort((a, b) => a.timestamp - b.timestamp);
}

function buildDigest_(entries, since, until, sheetUrl) {
  const count = entries.length;
  const headline = count + ' new ' + (count === 1 ? 'entry' : 'entries') + ' in the last 24 hours';
  const windowText = formatTime_(since) + ' – ' + formatTime_(until) + ' (' + DIGEST_TIMEZONE + ')';
  const subject = 'Form digest: ' + headline + ' (' + Utilities.formatDate(until, DIGEST_TIMEZONE, 'd MMM yyyy') + ')';

  const text = [headline, windowText, '']
    .concat(
      entries.map((entry, index) =>
        [
          index + 1 + '. ' + formatTime_(entry.timestamp) + ' · ' + entry.source,
          '   ' + entry.name + ' <' + entry.email + '>' + (entry.company ? ' · ' + entry.company : ''),
          '   ' + entry.message.replace(/\n/g, '\n   '),
          '',
        ].join('\n')
      )
    )
    .concat(['All entries: ' + sheetUrl])
    .join('\n');

  const cell = 'padding:10px 12px;border-bottom:1px solid #e5e7eb;vertical-align:top;';
  const head = 'padding:10px 12px;border-bottom:2px solid #d1d5db;text-align:left;font-size:12px;' +
    'text-transform:uppercase;letter-spacing:.04em;color:#6b7280;';
  const rows = entries
    .map((entry) =>
      '<tr>' +
      '<td style="' + cell + 'white-space:nowrap;color:#4b5563;">' + escapeHtml_(formatTime_(entry.timestamp)) + '</td>' +
      '<td style="' + cell + '"><strong>' + escapeHtml_(entry.name) + '</strong><br>' +
      '<a href="mailto:' + escapeHtml_(entry.email) + '" style="color:#2f54c9;">' + escapeHtml_(entry.email) + '</a>' +
      (entry.company ? '<br><span style="color:#6b7280;">' + escapeHtml_(entry.company) + '</span>' : '') + '</td>' +
      '<td style="' + cell + '">' + escapeHtml_(entry.message).replace(/\n/g, '<br>') + '</td>' +
      '<td style="' + cell + '"><span style="display:inline-block;padding:2px 8px;border-radius:999px;' +
      'background:#eef2ff;color:#3730a3;font-size:12px;">' + escapeHtml_(entry.source) + '</span></td>' +
      '</tr>'
    )
    .join('');

  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;color:#111827;max-width:760px;">' +
    '<p style="margin:0 0 4px;font-size:13px;color:#6b7280;">Daily form digest</p>' +
    '<h1 style="margin:0 0 4px;font-size:24px;">' + escapeHtml_(headline) + '</h1>' +
    '<p style="margin:0 0 20px;font-size:13px;color:#6b7280;">' + escapeHtml_(windowText) + '</p>' +
    '<table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;font-size:14px;">' +
    '<thead><tr><th style="' + head + '">Time</th><th style="' + head + '">From</th>' +
    '<th style="' + head + '">Message</th><th style="' + head + '">Source</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table>' +
    '<p style="margin:20px 0 0;font-size:13px;"><a href="' + escapeHtml_(sheetUrl) + '" style="color:#2f54c9;">' +
    'Open all entries in Google Sheets</a></p>' +
    '<p style="margin:8px 0 0;font-size:12px;color:#9ca3af;">Sent automatically at about 8:00 AM ' +
    '(Asia/Karachi) on days with new entries.</p>' +
    '</div>';

  return { subject: subject, text: text, html: html };
}

// --- Setup ---------------------------------------------------------------------------------

/**
 * Run once from the editor (and again any time; it is idempotent):
 * default settings, header row, and exactly one daily trigger at 8 AM Asia/Karachi.
 */
function setup() {
  // Google's consent screen lets people untick individual permissions. If any is missing, this
  // stops here and shows the approval prompt again instead of failing halfway through setup.
  ScriptApp.requireAllScopes(ScriptApp.AuthMode.FULL);
  const props = PropertiesService.getScriptProperties();
  const bound = SpreadsheetApp.getActiveSpreadsheet();
  setDefaultProperty_(props, 'SHEET_ID', bound ? bound.getId() : '');
  setDefaultProperty_(props, 'SHEET_NAME', 'Entries');
  setDefaultProperty_(props, 'RECIPIENTS', Session.getEffectiveUser().getEmail());
  if (!props.getProperty('SHEET_ID')) {
    throw new Error('Set the SHEET_ID script property (this script is not bound to a spreadsheet).');
  }

  const spreadsheet = getSpreadsheet_();
  spreadsheet.setSpreadsheetTimeZone(DIGEST_TIMEZONE);
  const sheet = getEntriesSheet_();
  sheet.getRange('A:A').setNumberFormat('yyyy-mm-dd hh:mm:ss');

  ScriptApp.getProjectTriggers()
    .filter((trigger) => trigger.getHandlerFunction() === DIGEST_TRIGGER_HANDLER)
    .forEach((trigger) => ScriptApp.deleteTrigger(trigger));
  ScriptApp.newTrigger(DIGEST_TRIGGER_HANDLER)
    .timeBased()
    .everyDays(1)
    .atHour(DIGEST_HOUR)
    .nearMinute(0)
    .inTimezone(DIGEST_TIMEZONE)
    .create();

  console.log(
    'Setup complete.\n' +
    'Sheet: ' + spreadsheet.getUrl() + ' (tab "' + sheet.getName() + '")\n' +
    'Digest recipients: ' + getRecipients_().join(', ') + '\n' +
    'Daily digest trigger: ~' + DIGEST_HOUR + ':00 ' + DIGEST_TIMEZONE
  );
}

function setDefaultProperty_(props, key, value) {
  if (!props.getProperty(key) && value) {
    props.setProperty(key, value);
  }
}

// --- Helpers -------------------------------------------------------------------------------

function getSpreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!id) {
    throw new Error('SHEET_ID is not set. Run setup() once from the script editor.');
  }
  return SpreadsheetApp.openById(id);
}

/** The entries tab, created with its header row if it does not exist yet. */
function getEntriesSheet_() {
  const spreadsheet = getSpreadsheet_();
  const name = PropertiesService.getScriptProperties().getProperty('SHEET_NAME') || 'Entries';
  let sheet = spreadsheet.getSheetByName(name);
  if (!sheet) {
    const sheets = spreadsheet.getSheets();
    // Reuse the blank default tab of a new spreadsheet instead of leaving it empty.
    sheet = sheets.length === 1 && sheets[0].getLastRow() === 0 ? sheets[0].setName(name) : spreadsheet.insertSheet(name);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function getRecipients_() {
  const raw = PropertiesService.getScriptProperties().getProperty('RECIPIENTS') || '';
  const recipients = raw.split(/[,;\s]+/).filter((address) => EMAIL_PATTERN.test(address));
  if (!recipients.length) {
    throw new Error('The RECIPIENTS script property has no valid email address.');
  }
  return recipients;
}

function toDate_(value) {
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? null : value;
  }
  const parsed = value ? new Date(value) : null;
  return parsed && !isNaN(parsed.getTime()) ? parsed : null;
}

function formatTime_(date) {
  return Utilities.formatDate(date, DIGEST_TIMEZONE, 'd MMM yyyy, HH:mm');
}

function escapeHtml_(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
