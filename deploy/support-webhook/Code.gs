/**
 * Cadence Support Webhook — Google Apps Script Web App
 *
 * Receives 1-click consent-gated diagnostic reports from Cadence Desktop (.zip)
 * and Cadence Remote Mobile (.json), saves the attachment to Google Drive,
 * and emails matbhuvitech@gmail.com with the bundle attached.
 */

var TARGET_EMAIL = 'matbhuvitech@gmail.com';
var DRIVE_FOLDER_NAME = 'Cadence Support Bundles';

function doGet() {
  return ContentService.createTextOutput(
    JSON.stringify({ ok: true, service: 'Cadence Support Webhook' })
  ).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonResponse({ ok: false, error: 'Missing request body' });
    }

    var payload = JSON.parse(e.postData.contents);
    var ticketId =
      sanitizeTicketId(payload.ticketId) ||
      'CAD-' +
        Utilities.formatDate(new Date(), 'UTC', 'yyyyMMdd') +
        '-' +
        Math.random().toString(36).substring(2, 6).toUpperCase();

    var attachmentBlob = buildAttachmentBlob(payload, ticketId);
    var driveFile = saveToDriveFolder(attachmentBlob);
    var driveFileUrl = driveFile ? driveFile.getUrl() : '';

    var scenarioLabel = payload.scenarioLabel || payload.scenarioId || 'General Diagnostic Report';
    var version = payload.desktopVersion || payload.platform || 'unknown';
    var subject = '[Cadence Support #' + ticketId + '] ' + scenarioLabel + ' (' + version + ')';

    var bodyLines = [
      'Ticket ID: ' + ticketId,
      'Source: ' + (payload.source || 'cadence-desktop'),
      'Issue Category: ' + scenarioLabel,
      'Version / Platform: ' + version + (payload.osInfo ? ' · ' + payload.osInfo : ''),
      'Reply Contact: ' + (payload.contactEmail || 'Not provided'),
      'Windows Service Running: ' + String(Boolean(payload.windowsServiceRunning)),
      'Engine Reachable: ' + String(Boolean(payload.activeEngineReachable)),
      driveFileUrl ? 'Google Drive Backup: ' + driveFileUrl : 'Google Drive Backup: N/A',
      '',
      'User Notes:',
      payload.userNotes && String(payload.userNotes).trim() ? String(payload.userNotes).trim() : '(none)',
      '',
      'Self-Diagnosis Findings:',
    ];

    if (Array.isArray(payload.hints) && payload.hints.length > 0) {
      for (var i = 0; i < payload.hints.length; i++) {
        var h = payload.hints[i] || {};
        bodyLines.push(
          '- [' +
            String(h.severity || 'info').toUpperCase() +
            '] ' +
            (h.code || 'HINT') +
            ': ' +
            (h.title || '') +
            (h.detail ? ' — ' + h.detail : '')
        );
      }
    } else {
      bodyLines.push('- (none)');
    }

    var mailOptions = {
      to: TARGET_EMAIL,
      subject: subject,
      body: bodyLines.join('\n'),
      attachments: [attachmentBlob],
    };
    if (payload.contactEmail && String(payload.contactEmail).indexOf('@') > 0) {
      mailOptions.replyTo = String(payload.contactEmail).trim();
    }

    MailApp.sendEmail(mailOptions);

    return jsonResponse({
      ok: true,
      ticketId: ticketId,
      driveFileUrl: driveFileUrl,
      message: 'Diagnostics delivered to ' + TARGET_EMAIL + ' (' + ticketId + ').',
    });
  } catch (err) {
    return jsonResponse({
      ok: false,
      error: err && err.message ? err.message : String(err),
    });
  }
}

function buildAttachmentBlob(payload, ticketId) {
  if (payload.zipBase64) {
    var bytes = Utilities.base64Decode(String(payload.zipBase64));
    var zipName = sanitizeFileName(payload.fileName || ticketId + '-cadence-support.zip');
    return Utilities.newBlob(bytes, 'application/zip', zipName);
  }
  var jsonContent =
    typeof payload.jsonPayload === 'string'
      ? payload.jsonPayload
      : JSON.stringify(payload.report || payload, null, 2);
  var jsonName = sanitizeFileName(payload.fileName || ticketId + '-cadence-mobile-support.json');
  return Utilities.newBlob(jsonContent, 'application/json', jsonName);
}

function saveToDriveFolder(blob) {
  var folders = DriveApp.getFoldersByName(DRIVE_FOLDER_NAME);
  var folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(DRIVE_FOLDER_NAME);
  return folder.createFile(blob);
}

function sanitizeTicketId(raw) {
  if (!raw) return '';
  return String(raw).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
}

function sanitizeFileName(raw) {
  return String(raw || 'cadence-support.zip').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 96);
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}
