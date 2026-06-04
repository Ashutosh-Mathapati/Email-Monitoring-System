require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { exec } = require("child_process");
const path = require("path");
const readline = require("readline");

// Import our new Services
const tokenManager = require("./TokenManager");
const emailService = require("./services/EmailService");
const aiService = require("./services/AIService");
const dbService = require("./services/DbService");
const calendarService = require("./services/CalendarService");
const notificationService = require("./services/NotificationService");
const pool = require("./db");
const app = express();
const PORT = process.env.PORT || 5000;
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let agentLoopStarted = false;

function isMeetingSchedulingTask(task) {
    const intent = String(task?.intent || "").toLowerCase();
    return intent === "schedule" || intent === "reschedule" || intent === "cancel";
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "..", "public"), { index: false }));
const tasksRouter = require("./routes/tasks");
app.use("/api/tasks", tasksRouter);

app.get("/api/dashboard", async (req, res) => {
    try {
        const email = tokenManager.currentEmail; 
        if (!email) {
            console.log("[API] No email found in session. Returning empty.");
            return res.json([]);
        }
        
        const cards = await dbService.getDashboardCards(email);
        console.log(`[API] Serving ${cards.length} cards for ${email}`);
        res.json(cards);
    } catch (err) {
        console.error("Dashboard API Error:", err);
        res.status(500).json([]);
    }
});

app.get("/api/debug/mail", async (req, res) => {
    try {
        const email = tokenManager.currentEmail;
        if (!email) {
            return res.status(400).json({ error: "No active executive email." });
        }

        const userRes = await pool.query(
            "SELECT tracking_start_date FROM users WHERE email = $1",
            [email.toLowerCase()]
        );
        const trackingStartDate = userRes.rows[0]?.tracking_start_date
            ? new Date(userRes.rows[0].tracking_start_date)
            : new Date(Date.now() - 24 * 60 * 60 * 1000);
        
        // Check if mailbox is unavailable
        if (emailService.mailboxUnavailable) {
            return res.json({
                activeEmail: email,
                trackingStartDate: trackingStartDate.toISOString(),
                messageCount: 0,
                messages: [],
                mailboxError: "Mailbox is not enabled for Microsoft Graph REST API. Email polling is disabled for this account."
            });
        }

        const messages = await emailService.fetchRecentEmails(10);

        res.json({
            activeEmail: email,
            trackingStartDate: trackingStartDate.toISOString(),
            messageCount: messages.length,
            messages: messages.map(message => ({
                id: message.id,
                subject: message.subject,
                from: message.from?.emailAddress?.address || null,
                receivedDateTime: message.receivedDateTime,
                afterTrackingStart: new Date(message.receivedDateTime) >= trackingStartDate
            }))
        });
    } catch (err) {
        res.status(500).json({ error: err.response?.data || err.message });
    }
});

function getMicrosoftLoginUrl(email) {
    const scopes = "openid profile offline_access Mail.Read Calendars.ReadWrite Mail.Send";
    // We add &state=${email} so Microsoft brings it back to us in the callback
    return `https://login.microsoftonline.com/${process.env.TENANT_ID}/oauth2/v2.0/authorize?client_id=${process.env.CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(process.env.REDIRECT_URI)}&response_mode=query&scope=${encodeURIComponent(scopes)}&state=${email}&prompt=select_account`;
}

// 1. HOME ROUTE
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "..", "public", "signup.html"));
});

app.get("/login", (req, res) => {
    const email = tokenManager.currentEmail || "unknown";
    res.redirect(getMicrosoftLoginUrl(email));
});

app.post("/api/auth/clear-token", (req, res) => {
    const email = (req.body.email || tokenManager.currentEmail || "").trim().toLowerCase();
    if (!email) {
        return res.status(400).json({ success: false, error: "Email is required." });
    }

    const removed = tokenManager.clearStoredToken(email);
    if (tokenManager.currentEmail?.toLowerCase() === email) {
        tokenManager.currentEmail = email;
    }

    res.json({ success: true, removed });
});

app.post("/api/signup", async (req, res) => {
    const { email, startDate } = req.body;

    if (!email || !startDate) {
        return res.status(400).send("Email and start date are required.");
    }

    const normalizedEmail = email.trim().toLowerCase();
    const parsedStartDate = new Date(startDate);

    if (Number.isNaN(parsedStartDate.getTime())) {
        return res.status(400).send("Invalid start date.");
    }

    try {
        tokenManager.currentEmail = normalizedEmail;
        await pool.query(
            "INSERT INTO users (email, tracking_start_date) VALUES ($1, $2) ON CONFLICT (email) DO UPDATE SET tracking_start_date = EXCLUDED.tracking_start_date",
            [normalizedEmail, parsedStartDate.toISOString()]
        );
        emailService.resetTracking(normalizedEmail);
        res.redirect("/login");
    } catch (err) {
        console.error("Signup Error:", err.message);
        res.status(500).send("Signup Error");
    }
});

// 1. UPDATE ROUTE: Saves manual changes from Dashboard (Req 6.ii & 3)
app.post("/api/tasks/update", async (req, res) => {
    const { id, task_order, priority } = req.body;
    try {
        await dbService.updateTaskData(id, task_order, priority);
        res.json({ success: true });
    } catch (err) {
        res.status(500).send(err.message);
    }
});

app.post("/api/tasks/delete-card", async (req, res) => {
    const { email_id } = req.body;
    try {
        await pool.query("DELETE FROM tasks WHERE email_id = $1", [email_id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete("/api/tasks/delete/:id", async (req, res) => {
    try {
        await pool.query("DELETE FROM tasks WHERE id = $1", [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// 2. APPROVE ROUTE: Implements Requirement 8 (Dependent Adjustment / Stacking)
app.post("/api/tasks/approve", async (req, res) => {
    const { id } = req.body;
    try {
        const currentTask = await dbService.getTaskById(id);

        if (!currentTask) {
            return res.status(404).json({ error: "Task not found" });
        }

        if (!isMeetingSchedulingTask(currentTask)) {
            return res.status(400).json({
                error: "Scheduling is only available for meeting-intent tasks."
            });
        }

        const lastTaskRes = await pool.query(
            "SELECT end_time FROM tasks WHERE email_id = $1 AND status = 'Scheduled' ORDER BY end_time DESC LIMIT 1",
            [currentTask.email_id]
        );

        if (lastTaskRes.rows.length > 0) {
            currentTask.suggested_time = lastTaskRes.rows[0].end_time;
            console.log(`[REQ 8] Stacking after previous task: ${currentTask.suggested_time}`);
        }

        const schedule = await calendarService.scheduleTask(currentTask);
        if (schedule) {
            await dbService.updateScheduledTask(id, schedule.eventId, schedule.start, schedule.end);
            res.json({ success: true });
        } else {
            res.status(500).json({ error: "Scheduling failed" });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. TERMINAL INPUT
rl.question("\nEnter Executive Email Address: ", async (email) => {
    tokenManager.currentEmail = email.trim();
    const hasToken = tokenManager.initFromStorage(tokenManager.currentEmail);

    if (hasToken) {
        console.log(`\n[RECOGNIZED] Welcome back, ${tokenManager.currentEmail}.`);
        await tokenManager.getAccessToken(); 
        startAgentLoop();
    } else {
        console.log(`\n[NEW USER] Opening browser for one-time authentication...`);
        exec(`start http://localhost:${PORT}`);
    }
});

// 3. AUTH CALLBACK
app.get("/auth/callback", async (req, res) => {
    const code = req.query.code;
    const emailFromMicrosoft = req.query.state; // Recover the email here!

    try {
        const response = await axios.post(
            `https://login.microsoftonline.com/common/oauth2/v2.0/token`,
            new URLSearchParams({
                client_id: process.env.CLIENT_ID,
                client_secret: process.env.CLIENT_SECRET,
                code: code,
                redirect_uri: process.env.REDIRECT_URI,
                grant_type: "authorization_code",
            })
        );

        // RESTORE the email before calling setTokens
        tokenManager.currentEmail = emailFromMicrosoft;
        tokenManager.setTokens(response.data);

        console.log(`[AUTH] Successfully logged in for: ${emailFromMicrosoft}`);
        startAgentLoop();
        res.redirect("/index.html");
    } catch (err) {
        console.error("Auth Error:", err.response?.data || err.message);
        res.send("Authentication failed. Please go back to Signup and try again.");
    }
});


// 4. THE MERGED AGENT LOGIC (THE BRAIN)
async function startAgentLoop() {
    if (agentLoopStarted) {
        console.log(`[AGENT] Agent loop already active for ${tokenManager.currentEmail}.`);
        return;
    }

    agentLoopStarted = true;
    console.log(`\n--- AI EXECUTIVE AGENT ACTIVE: ${tokenManager.currentEmail} ---`);

    const ensureTrackingStartDate = async () => {
        const email = tokenManager.currentEmail?.toLowerCase();
        if (!email) return null;

        const userRes = await pool.query(
            "SELECT tracking_start_date FROM users WHERE email = $1",
            [email]
        );

        if (userRes.rows[0]) {
            return new Date(userRes.rows[0].tracking_start_date);
        }

        const defaultStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
        await pool.query(
            `INSERT INTO users (email, tracking_start_date)
             VALUES ($1, $2)
             ON CONFLICT (email)
             DO UPDATE SET tracking_start_date = EXCLUDED.tracking_start_date`,
            [email, defaultStart.toISOString()]
        );
        console.warn(`[SYNC] No tracking start found for ${email}. Created default start: ${defaultStart.toISOString()}`);
        return defaultStart;
    };

    const pollEmails = async () => {
        try {
            const trackingStartDate = await ensureTrackingStartDate();
            if (!trackingStartDate) {
                console.warn("[SYNC] No active executive email; skipping mail poll.");
                return;
            }

            let emails = await emailService.fetchNewEmails();

            if (emails.length === 0) {
                console.log("[SYNC] /me/messages returned 0 email(s) this cycle.");
                return;
            }

            console.log(`[SYNC] Evaluating ${emails.length} email(s). Tracking start: ${trackingStartDate.toISOString()}`);

            for (const email of emails) {
                const emailReceivedTime = new Date(email.receivedDateTime);
                const emailBody = email.body?.content || await emailService.fetchMessageBody(email.id) || email.bodyPreview || "";
                const emailText = aiService.getEmailText(emailBody);

                // --- THE TRIPLE GATE ---

                // GATE 1: TIME FILTER
                // If the email arrived BEFORE your tracking cutoff, ignore it.
                if (emailReceivedTime < trackingStartDate) {
                    if (process.env.DEBUG_EMAIL_SYNC === "true") {
                        console.log(`[SKIP] Before tracking start: "${email.subject}" received ${emailReceivedTime.toISOString()}`);
                    }
                    continue;
                }

                // GATE 2: DUPLICATE CHECK
                const processingState = await dbService.getEmailProcessingState(email.id);
                if (processingState.has_tasks) {
                    if (process.env.DEBUG_EMAIL_SYNC === "true") {
                        console.log(`[SKIP] Already has tasks: "${email.subject}" (${email.id})`);
                    }
                    continue;
                }

                if (processingState.seen && !aiService.hasActionCue(email.subject, emailText)) {
                    if (process.env.DEBUG_EMAIL_SYNC === "true") {
                        console.log(`[SKIP] Seen no-action email: "${email.subject}" (${email.id})`);
                    }
                    continue;
                }

                if (processingState.seen) {
                    console.log(`[REPROCESS] Seen email has action cues but no tasks yet: "${email.subject}"`);
                }

                // ONLY IF IT PASSES BOTH GATES:
                console.log(`\n[AI START] Analyzing: "${email.subject}"`);
                const fromEmail = email.from?.emailAddress?.address || null;
                const aiResponse = await aiService.analyzeEmail(email.subject, emailText, fromEmail, email.receivedDateTime);
                
                // REQUIREMENT 1.5: No action if no meeting intent is detected.
                if (!aiResponse || aiResponse.action_required === false) {
                    console.log(`[IGNORE] No meeting intent detected in: "${email.subject}"`);
                    await dbService.markEmailAsSeen(email.id);
                    continue;
                }

                const rawTasks = Array.isArray(aiResponse.tasks) ? aiResponse.tasks : [];

                if (rawTasks.length > 0) {
                    const badTitles = ["research", "update", "finalize", "schedule", "survey"];
                    const finalTasks = [];

                    const seenTaskKeys = new Set();
                    rawTasks.forEach(task => {
                        const titleText = (task.title || task.action_item || "").toString().trim();
                        const titleWords = titleText.split(" ").filter(Boolean);
                        let validatedTitle = titleText;

                        if (titleWords.length < 2 || badTitles.includes(titleText.toLowerCase())) {
                            console.warn(`[VALIDATOR] Generic task rejected: ${titleText}`);
                            const descriptionText = (task.description || "").toString().trim();
                            const fallback = descriptionText ? `${titleText} - ${descriptionText.substring(0, 30)}` : `${titleText} task`;
                            validatedTitle = fallback;
                        }

                        if (validatedTitle.toLowerCase().includes(" and ")) {
                            console.log(`[VALIDATOR] Split needed for: ${validatedTitle}`);
                        }

                        const dedupeKey = validatedTitle.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
                        if (seenTaskKeys.has(dedupeKey)) {
                            return;
                        }
                        seenTaskKeys.add(dedupeKey);

                        finalTasks.push({
                            ...task,
                            title: validatedTitle,
                            action_item: validatedTitle
                        });
                    });

                    let limitedTasks = finalTasks;
                    if (limitedTasks.length > 5) {
                        limitedTasks = limitedTasks.slice(0, 5);
                    }

                    for (const [taskIndex, t] of limitedTasks.entries()) {
                        const intent = t.intent || "schedule";
                        const confidence = t.confidence || "HIGH";

                        // Determine status: Needs Clarification if LOW confidence or critical fields missing
                        let status = 'Awaiting Approval';
                        if (confidence === 'LOW') {
                            status = 'Needs Clarification';
                        }

                        // Auto-route reschedule/cancel intents if we can find the target meeting
                        if (intent === 'cancel' || intent === 'reschedule') {
                            const existingScheduled = await pool.query(
                                `SELECT * FROM tasks 
                                 WHERE sender_email = $1 
                                 AND status = 'Scheduled' 
                                 AND intent = 'schedule'
                                 ORDER BY end_time DESC LIMIT 1`,
                                [fromEmail]
                            );

                            if (existingScheduled.rows.length > 0) {
                                const existingTask = existingScheduled.rows[0];
                                if (intent === 'cancel') {
                                    console.log(`[AUTO-ROUTE] Cancelling meeting "${existingTask.action_item}" via email intent`);
                                    const cancelResult = await calendarService.cancelMeeting(existingTask);
                                    if (cancelResult.success) {
                                        await pool.query(
                                            "UPDATE tasks SET status = 'Cancelled', outlook_event_id = NULL WHERE id = $1",
                                            [existingTask.id]
                                        );
                                        console.log(`[AUTO-ROUTE] Meeting cancelled: ${existingTask.action_item}`);
                                        continue; // Skip creating a new task
                                    }
                                } else if (intent === 'reschedule' && t.suggested_time) {
                                    console.log(`[AUTO-ROUTE] Rescheduling meeting "${existingTask.action_item}" to ${t.suggested_time}`);
                                    await dbService.updateTaskSuggestedTime(existingTask.id, t.suggested_time);
                                    const schedule = await calendarService.updateCalendarEvent(existingTask, t.suggested_time);
                                    if (schedule) {
                                        await dbService.updateScheduledTask(existingTask.id, schedule.eventId, schedule.start, schedule.end);
                                        console.log(`[AUTO-ROUTE] Meeting rescheduled: ${existingTask.action_item}`);
                                        continue;
                                    }
                                }
                            }
                            // If no existing meeting found, fall through to save as Needs Clarification
                            status = 'Needs Clarification';
                        }

                        const taskData = {
                            action_item: t.title || t.action_item || t.description || "Untitled task",
                            intent,
                            participants: Array.isArray(t.participants) ? t.participants : [],
                            priority: t.priority || "Medium",
                            confidence,
                            duration: t.duration || 30,
                            description: t.description || '', // Task-specific summary
                            suggested_time: t.suggested_time || null,  // Include AI-extracted date/time
                            status
                        };

                        try {
                            await dbService.saveTask(
                                email.id,
                                email.subject,
                                aiResponse.overall_summary || "Executive Action Required",
                                taskData,
                                fromEmail,
                                email.receivedDateTime,
                                taskIndex
                            );
                            console.log(`[QUEUED] [${status}] ${taskData.action_item}`);
                        } catch (dbErr) {
                            console.error("[DB ERROR] Failed to save task:", dbErr.message);
                        }
                    }

                    console.log(`[QUEUED] ${limitedTasks.length} context-rich tasks processed.`);
                    await dbService.markEmailAsSeen(email.id);
                } else {
                    // Fallback handled inside AIService.analyzeEmail already.
                    await dbService.markEmailAsSeen(email.id);
                }
            }
        } catch (err) {
            console.error("Loop Error:", err.message);
        }
    };

    await pollEmails();
    setInterval(pollEmails, 30000); // 30 seconds is plenty

    setInterval(processTaskCompletions, 60000); // Checks every 1 minute for finished scheduled tasks
}

async function processTaskCompletions() {
    console.log("[STATUS CHECK] Scanning for finished tasks...");

    try {
        const finishedTasks = await dbService.getFinishedTasks();

        for (const task of finishedTasks) {
            console.log(`[COMPLETING] Task "${task.action_item}" is finished. Sending notification to ${task.sender_email}...`);

            const isSent = await notificationService.sendCompletionEmail(task.sender_email, task.action_item);

            if (isSent) {
                await dbService.markTaskAsCompleted(task.id);
                console.log(`[DONE] Task ID ${task.id} moved to Completed status.`);
            }
        }
    } catch (err) {
        console.error("Completion Loop Error:", err.message);
    }
}

app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
});
