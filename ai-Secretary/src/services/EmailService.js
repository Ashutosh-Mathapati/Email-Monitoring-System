// This uses simple message polling because it works with more Outlook mailbox types than folder delta APIs.

// EmailService.js
const axios = require("axios");
const tokenManager = require("../TokenManager");
const pool = require("../db");

class EmailService {
    constructor() {
        this.deltaLink = null;
        this.executiveEmail = null;
        this.trackingStartDate = null;
        this.lastHistoryWarningAt = 0;
        this.mailboxUnavailable = false;
    }

    resetTracking(executiveEmail = null) {
        this.deltaLink = null;
        this.executiveEmail = executiveEmail;
        this.trackingStartDate = null;
        this.mailboxUnavailable = false;
    }

    async getTrackingStartDate(executiveEmail) {
        if (!executiveEmail) {
            return null;
        }

        const userRes = await pool.query(
            "SELECT tracking_start_date FROM users WHERE email = $1",
            [executiveEmail]
        );

        return userRes.rows[0]?.tracking_start_date || null;
    }

    async fetchNewEmails() {
        try {
            return await this.fetchRecentEmails(20);

        } catch (err) {
            console.error("[EMAIL] Message polling failed:", err.response?.data || err.message);
            return [];
        }
    }

    logHistoryWarning(message) {
        const now = Date.now();
        if (now - this.lastHistoryWarningAt > 5 * 60 * 1000) {
            console.warn(message);
            this.lastHistoryWarningAt = now;
        }
    }

    canFetchRecentHistory() {
        return true;
    }

    async fetchInboxFolderId(headers) {
        if (this.mailboxUnavailable) {
            return null;
        }

        try {
            const response = await axios.get(
                "https://graph.microsoft.com/v1.0/me/mailFolders?$top=100&$select=id,displayName",
                { headers }
            );
            const folders = response.data.value || [];
            const inbox = folders.find(folder => (folder.displayName || "").toLowerCase() === "inbox");
            return inbox?.id || null;
        } catch (err) {
            if (err.response?.data?.error?.code === "MailboxNotEnabledForRESTAPI") {
                this.mailboxUnavailable = true;
                console.error("[EMAIL] Mailbox is not enabled for Microsoft Graph REST API. Inbox folder discovery disabled.");
            } else {
                console.error("[EMAIL] Inbox folder discovery failed:", err.response?.data || err.message);
            }
            return null;
        }
    }

    async fetchRecentEmails(limit = 20, sinceDate = null) {
        if (this.mailboxUnavailable) {
            if (process.env.DEBUG_EMAIL_SYNC === "true") {
                console.warn("[EMAIL] Mailbox unavailable for Graph; skipping email polling.");
            }
            return [];
        }

        const token = await tokenManager.getAccessToken();
        const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 50);
        const headers = { Authorization: `Bearer ${token}` };
        const selectFields = "id,subject,from,body,bodyPreview,receivedDateTime";
        const select = `$select=${selectFields}`;
        const encodedOrderBy = encodeURIComponent("receivedDateTime desc");
        const legacyUrl = `https://graph.microsoft.com/v1.0/me/messages?$top=${safeLimit}&$orderby=receivedDateTime DESC`;
        const urls = [
            legacyUrl,
            `https://graph.microsoft.com/v1.0/me/messages?$top=${safeLimit}&${select}&$orderby=${encodedOrderBy}`,
            `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=${safeLimit}&${select}&$orderby=${encodedOrderBy}`,
            `https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages?$top=${safeLimit}&${select}&$orderby=${encodedOrderBy}`
        ];
        const since = sinceDate ? new Date(sinceDate) : null;

        for (const url of urls) {
            try {
                const response = await axios.get(url, { headers });
                const messages = response.data.value || [];
                const endpoint = url === legacyUrl ? "/me/messages legacy" : "/me/messages";
                console.log(`[SYNC] ${endpoint} polling returned ${messages.length} message(s).`);
                return this.filterRecentMessages(messages, since);
            } catch (err) {
                const status = err.response?.status;
                const code = err.response?.data?.error?.code;
                if (url === legacyUrl) {
                    console.error("[EMAIL] Legacy /me/messages fetch failed:", err.response?.data || err.message);
                }

                if (code === "MailboxNotEnabledForRESTAPI") {
                    this.mailboxUnavailable = true;
                    console.error("[EMAIL] Mailbox is not enabled for Microsoft Graph REST API. Email polling will be disabled for this account.");
                    return [];
                }

                if (status === 404 || code === "ErrorItemNotFound") {
                    continue;
                }
                console.error("[EMAIL] Recent history fetch failed:", err.response?.data || err.message);
                return [];
            }
        }

        const inboxId = await this.fetchInboxFolderId(headers);
        if (inboxId) {
            try {
                const encodedInboxId = encodeURIComponent(inboxId);
                const response = await axios.get(
                    `https://graph.microsoft.com/v1.0/me/mailFolders/${encodedInboxId}/messages?$top=${safeLimit}&${select}&$orderby=${encodedOrderBy}`,
                    { headers }
                );
                const messages = response.data.value || [];
                console.log(`[SYNC] Inbox folder history fetch returned ${messages.length} message(s).`);
                return this.filterRecentMessages(messages, since);
            } catch (err) {
                console.error("[EMAIL] Inbox folder history fetch failed:", err.response?.data || err.message);
                return [];
            }
        }

        if (process.env.DEBUG_EMAIL_SYNC === "true") {
            this.logHistoryWarning("[SYNC] Recent email history is unavailable for this mailbox/account. Agent will keep polling /me/messages.");
        }
        return [];
    }

    filterRecentMessages(messages, since) {
        if (!since || Number.isNaN(since.getTime())) {
            return messages;
        }

        const filtered = messages.filter(message => {
            const received = new Date(message.receivedDateTime);
            return !Number.isNaN(received.getTime()) && received >= since;
        });

        if (messages.length > 0 && filtered.length === 0) {
            const newest = messages
                .map(message => new Date(message.receivedDateTime))
                .filter(date => !Number.isNaN(date.getTime()))
                .sort((a, b) => b - a)[0];
            console.log(`[SYNC] Graph returned ${messages.length} message(s), but none were after tracking start ${since.toISOString()}. Newest seen: ${newest ? newest.toISOString() : "unknown"}`);
        }

        return filtered;
    }

    async fetchMessageBody(messageId) {
        if (!messageId) return "";

        try {
            const token = await tokenManager.getAccessToken();
            const url = `https://graph.microsoft.com/v1.0/me/messages/${messageId}?$select=body,bodyPreview`;
            const response = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });
            return response.data.body?.content || response.data.bodyPreview || "";
        } catch (err) {
            console.error("[EMAIL] Failed to fetch full message body:", err.response?.data || err.message);
            return "";
        }
    }
}

module.exports = new EmailService();
