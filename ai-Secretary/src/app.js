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

function getMicrosoftLoginUrl(email) {
    const scopes = "openid profile offline_access Mail.Read Calendars.ReadWrite Mail.Send";
    // We add &state=${email} so Microsoft brings it back to us in the callback
    return `https://login.microsoftonline.com/${process.env.TENANT_ID}/oauth2/v2.0/authorize?client_id=${process.env.CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(process.env.REDIRECT_URI)}&response_mode=query&scope=${encodeURIComponent(scopes)}&state=${email}`;
}

// 1. HOME ROUTE
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "..", "public", "signup.html"));
});

app.get("/login", (req, res) => {
    const email = tokenManager.currentEmail || "unknown";
    res.redirect(getMicrosoftLoginUrl(email));
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

        if (currentTask.date_type === 'reference' || currentTask.date_type === 'deadline') {
            return res.status(400).json({ error: "Tasks classified as reference or deadline cannot be booked on the calendar." });
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
    console.log(`\n--- 🚀 AI EXECUTIVE AGENT ACTIVE: ${tokenManager.currentEmail} ---`);
    
    setInterval(async () => {
        try {
            let emails = await emailService.fetchNewEmails();

            // 1. FALLBACK: Fetch history if delta is empty
            if (emails.length === 0) {
                console.log("[SYNC] Delta empty. Checking recent history...");
                const token = await tokenManager.getAccessToken();
                const historyRes = await axios.get("https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=20", {
                    headers: { Authorization: `Bearer ${token}` }
                });
                emails = historyRes.data.value;
            }

            // 2. GET THE USER'S TRACKING TIME FROM DATABASE
            const userRes = await pool.query("SELECT tracking_start_date FROM users WHERE email = $1", [tokenManager.currentEmail.toLowerCase()]);
            if (!userRes.rows[0]) return;

            // Convert the DB date to a real JavaScript Date object
            const trackingStartDate = new Date(userRes.rows[0].tracking_start_date);

            for (const email of emails) {
                const emailReceivedTime = new Date(email.receivedDateTime);

                // --- THE TRIPLE GATE ---

                // GATE 1: TIME FILTER
                // If the email arrived BEFORE your tracking cutoff, ignore it.
                if (emailReceivedTime < trackingStartDate) {
                    continue;
                }

                // GATE 2: DUPLICATE CHECK
                if (await dbService.isEmailProcessed(email.id)) {
                    continue;
                }

                // ONLY IF IT PASSES BOTH GATES:
                console.log(`\n[AI START] Analyzing: "${email.subject}"`);
                const aiResponse = await aiService.analyzeEmail(email.subject, email.bodyPreview);
                const rawTasks = Array.isArray(aiResponse) ? aiResponse : aiResponse?.tasks;
                const overallSummary = aiResponse?.overall_summary || "Executive Action Required";

                if (rawTasks && Array.isArray(rawTasks)) {
                    const badTitles = ["research", "update", "finalize", "schedule", "survey"];
                    const finalTasks = [];

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

                        finalTasks.push({
                            ...task,
                            title: validatedTitle,
                            action_item: validatedTitle,
                            date_type: task.date_type || "none",
                            suggested_time: task.suggested_time || null,
                            priority: task.priority || "Medium"
                        });
                    });

                    let limitedTasks = finalTasks;
                    if (limitedTasks.length > 5) {
                        limitedTasks = limitedTasks.slice(0, 5);
                    }

                    for (const t of limitedTasks) {
                        let finalSuggestedTime = t.suggested_time || null;
                        if (t.date_type === "reference" || t.date_type === "deadline") {
                            console.log(`[VALIDATOR] Preventing scheduling for ${t.date_type} task: ${t.title}`);
                            finalSuggestedTime = null;
                        }

                        const taskData = {
                            action_item: t.title || t.action_item || t.description || "Untitled task",
                            priority: t.priority || "Medium",
                            confidence: t.confidence || "HIGH",
                            duration: t.duration || 30,
                            date_type: t.date_type,
                            suggested_time: finalSuggestedTime
                        };

                        try {
                            await dbService.saveTask(
                                email.id,
                                email.subject,
                                overallSummary,
                                taskData,
                                email.from.emailAddress.address,
                                email.receivedDateTime
                            );
                            console.log(`[QUEUED] ${taskData.action_item}`);
                        } catch (dbErr) {
                            console.error("[DB ERROR] Failed to save task:", dbErr.message);
                        }
                    }

                    console.log(`[QUEUED] ${limitedTasks.length} context-rich tasks processed.`);
                }
            }
        } catch (err) {
            console.error("Loop Error:", err.message);
        }
    }, 30000); // 30 seconds is plenty

    setInterval(processTaskCompletions, 60000); // Checks every 1 minute for finished scheduled tasks
}

async function processTaskCompletions() {
    console.log("[STATUS CHECK] Scanning for finished tasks...");

    try {
        const finishedTasks = await dbService.getFinishedTasks();
        console.log(`[STATUS CHECK] Found ${finishedTasks.length} tasks ready for notification.`);

        for (const task of finishedTasks) {
            console.log(`[NOTIFYING] Attempting to email ${task.sender_email} for task: ${task.action_item}`);

            const isSent = await notificationService.sendCompletionEmail(task.sender_email, task.action_item);

            if (isSent) {
                await dbService.markTaskAsCompleted(task.id);
                console.log(`[DONE] Task ID ${task.id} finalized.`);
            }
        }
    } catch (err) {
        console.error("Completion Loop Error:", err.message);
    }
}

async function initServer() {
    try {
        await dbService.ensureSchema();
    } catch (err) {
        console.error("[SCHEMA] Initialization failed:", err.message);
    }

    app.listen(PORT, () => {
        console.log(`Server listening on http://localhost:${PORT}`);
    });
}

initServer();
