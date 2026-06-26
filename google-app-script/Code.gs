// ══════════════════════════════════════════════════════════════
// QPC HR Automation — Google Apps Script
// ══════════════════════════════════════════════════════════════

const CODA_API_TOKEN = PropertiesService.getScriptProperties().getProperty("CODA_API_TOKEN");
const CODA_DOC_ID = "b6UvgZm6mK";
const INTERVIEW_TRACKER_TABLE = "grid-noePI2YD13";
const SPREADSHEET_ID = "1oMoHqFqbMEm_iKCfQVeHPR02gkLwr3j36fyhN65qiJE";
const SLACK_WEBHOOK_URL = PropertiesService.getScriptProperties().getProperty("SLACK_WEBHOOK_URL");

const INACTIVE_DAYS_THRESHOLD = 7;

const REJECTION_STATUSES = [
  "Not Continuing",
  "Not Qualified",
  "Offered & Rejected",
  "Rejected"
];

const ACTIVE_STATUSES = [
  "Interviewing",
  "Approved for Offer",
  "Offerred Letter"
];

function getCandidates() {
  const url = `https://coda.io/apis/v1/docs/${CODA_DOC_ID}/tables/${INTERVIEW_TRACKER_TABLE}/rows?useColumnNames=true`;
  const options = {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${CODA_API_TOKEN}`,
      "Content-Type": "application/json"
    }
  };
  const response = UrlFetchApp.fetch(url, options);
  const data = JSON.parse(response.getContentText());
  return data.items;
}

function sendSlackNotification(candidateName, position, status, message) {
  if (!SLACK_WEBHOOK_URL) return;
  const statusEmoji = {
    "Offerred Letter": "🎉",
    "Not Continuing": "❌",
    "Not Qualified": "❌",
    "Offered & Rejected": "🚫",
    "Rejected": "🚫",
    "Interviewing": "📅",
    "Accepted and Onboarded": "✅",
    "INACTIVE": "⚠️"
  }[status] || "📋";
  const displayMessage = message || `Status: ${status}`;
  const payload = {
    text: `${statusEmoji} *HR Update*`,
    blocks: [
      { type: "header", text: { type: "plain_text", text: `${statusEmoji} ${displayMessage}` } },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Candidate:*\n${candidateName}` },
          { type: "mrkdwn", text: `*Role:*\n${position}` },
          { type: "mrkdwn", text: `*Status:*\n${status}` },
          { type: "mrkdwn", text: `*Time:*\n${new Date().toLocaleString()}` }
        ]
      }
    ]
  };
  UrlFetchApp.fetch(SLACK_WEBHOOK_URL, {
    method: "POST",
    contentType: "application/json",
    payload: JSON.stringify(payload)
  });
  Logger.log(`Slack notification sent for ${candidateName} — ${status}`);
}

function sendOfferEmail(name, email, position, startDate) {
  const subject = `Offer Letter — ${position} at Quantum Pulse Consulting`;
  const body = `Hi ${name},\n\nWe are thrilled to offer you the ${position} position at Quantum Pulse Consulting!\n\nStart Date: ${startDate || "TBD"}\n\nPlease complete your application form here:\nhttps://coda.io/form/New-Intern-Form_d_Y8WXOeTDO\n\nWe look forward to having you on the team!\n\nBest regards,\nQuantum Pulse Consulting HR Team`;
  GmailApp.sendEmail(email, subject, body);
  Logger.log(`Offer email sent to ${name} (${email})`);
}

function sendRejectionEmail(name, email, position) {
  const subject = `Your Application at Quantum Pulse Consulting`;
  const body = `Hi ${name},\n\nThank you for taking the time to interview with us for the ${position} position. We truly appreciate your interest in joining Quantum Pulse Consulting and the effort you put into the process.\n\nAfter careful consideration, we have decided to move forward with other candidates whose experience more closely aligns with our current needs. This was not an easy decision, as we were impressed by your background.\n\nWe encourage you to keep an eye on our future openings and apply again. We wish you all the best in your career journey.\n\nWarm regards,\nQuantum Pulse Consulting HR Team`;
  GmailApp.sendEmail(email, subject, body);
  Logger.log(`Rejection email sent to ${name} (${email})`);
}

function sendInterviewEmail(name, email, position, interviewDate) {
  const subject = `Interview Confirmation — ${position} at Quantum Pulse Consulting`;
  const body = `Hi ${name},\n\nYour interview for the ${position} position at Quantum Pulse Consulting has been confirmed!\n\nInterview Date: ${interviewDate || "TBD"}\n\nPlease make sure to be available and check your calendar for the meeting link.\n\nBest regards,\nQuantum Pulse Consulting HR Team`;
  GmailApp.sendEmail(email, subject, body);
  Logger.log(`Interview confirmation sent to ${name} (${email})`);
}

function sendOnboardingEmail(name, email, position, startDate) {
  const subject = `Welcome to Quantum Pulse Consulting!`;
  const body = `Hi ${name},\n\nWelcome to Quantum Pulse Consulting! We are so excited to have you join us as ${position}.\n\nStart Date: ${startDate || "TBD"}\n\nHere are your next steps:\n1. Complete your onboarding form: https://coda.io/form/New-Intern-Form_d_Y8WXOeTDO\n2. Read the initial onboarding materials on Coda\n3. You will receive your QPC email shortly\n\nWelcome aboard!\nQuantum Pulse Consulting HR Team`;
  GmailApp.sendEmail(email, subject, body);
  Logger.log(`Onboarding email sent to ${name} (${email})`);
}

function sendFollowUpReminderEmail(name, email, position, status, daysSinceUpdate) {
  const subject = `Follow-up: Your Application at Quantum Pulse Consulting`;
  const body = `Hi ${name},\n\nWe wanted to follow up regarding your application for the ${position} position at Quantum Pulse Consulting.\n\nYour application is currently in the "${status}" stage. We want to make sure you have the latest information and that we haven't missed anything on our end.\n\nIf you have any questions or updates, please don't hesitate to reach out to our HR team.\n\nWe appreciate your patience and continued interest in joining our team.\n\nBest regards,\nQuantum Pulse Consulting HR Team`;
  GmailApp.sendEmail(email, subject, body);
  Logger.log(`Follow-up reminder sent to ${name} (${email}) — inactive ${daysSinceUpdate} days`);
}

function getOrCreateSheet() {
  try {
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    return ss.getSheets()[0];
  } catch(e) {
    const ss = SpreadsheetApp.create("QPC HR Email Log");
    const sheet = ss.getSheets()[0];
    sheet.appendRow(["Timestamp", "Name", "Email", "Status", "Action"]);
    return sheet;
  }
}

function wasReminderSentToday(sheet, email, actionType) {
  const today = new Date().toDateString();
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    const rowDate = new Date(data[i][0]).toDateString();
    const rowEmail = data[i][2];
    const rowAction = data[i][4];
    if (rowDate === today && rowEmail === email && rowAction === actionType) {
      return true;
    }
  }
  return false;
}

function checkAndSendEmails() {
  const sheet = getOrCreateSheet();
  const candidates = getCandidates();
  candidates.forEach(candidate => {
    const values = candidate.values;
    const name = values["Name"] || "";
    const email = values["Email"] || "";
    const status = values["Status"] || "";
    const position = values["Position"] || "Intern";
    const startDate = values["Starting date"] || "";
    const interviewDate = values["Date and Time of Interview"] || "";
    if (!email) return;
    const timestamp = new Date();
    const actionType = `email_${status}`;
    if (wasReminderSentToday(sheet, email, actionType)) {
      Logger.log(`Skipping ${name} — already notified today for status: ${status}`);
      return;
    }
    if (status === "Offerred Letter") {
      sendOfferEmail(name, email, position, startDate);
      sendSlackNotification(name, position, status, "Candidate Status Update");
      sheet.appendRow([timestamp, name, email, status, actionType]);
    } else if (REJECTION_STATUSES.includes(status)) {
      sendRejectionEmail(name, email, position);
      sendSlackNotification(name, position, status, "Candidate Status Update");
      sheet.appendRow([timestamp, name, email, status, actionType]);
    } else if (status === "Interviewing") {
      sendInterviewEmail(name, email, position, interviewDate);
      sendSlackNotification(name, position, status, "Candidate Status Update");
      sheet.appendRow([timestamp, name, email, status, actionType]);
    } else if (status === "Accepted and Onboarded") {
      sendOnboardingEmail(name, email, position, startDate);
      sendSlackNotification(name, position, status, "Candidate Status Update");
      sheet.appendRow([timestamp, name, email, status, actionType]);
    }
  });
  Logger.log("Email + Slack check complete.");
}

function checkInactiveCandidates() {
  const sheet = getOrCreateSheet();
  const candidates = getCandidates();
  const now = new Date();
  candidates.forEach(candidate => {
    const values = candidate.values;
    const name = values["Name"] || "";
    const email = values["Email"] || "";
    const status = values["Status"] || "";
    const position = values["Position"] || "Intern";
    const updatedAt = candidate.updatedAt;
    if (!email) return;
    if (!ACTIVE_STATUSES.includes(status)) return;
    const lastUpdate = new Date(updatedAt);
    const daysSinceUpdate = Math.floor((now - lastUpdate) / (1000 * 60 * 60 * 24));
    if (daysSinceUpdate < INACTIVE_DAYS_THRESHOLD) return;
    const actionType = "follow_up_reminder";
    if (wasReminderSentToday(sheet, email, actionType)) {
      Logger.log(`Skipping ${name} — follow-up already sent today`);
      return;
    }
    sendFollowUpReminderEmail(name, email, position, status, daysSinceUpdate);
    sendSlackNotification(name, position, "INACTIVE", `⚠️ Inactive Candidate Alert — ${name} has been in "${status}" for ${daysSinceUpdate} days`);
    sheet.appendRow([new Date(), name, email, status, actionType]);
    Logger.log(`Follow-up sent for ${name} — inactive ${daysSinceUpdate} days`);
  });
  Logger.log("Inactive candidate check complete.");
}
