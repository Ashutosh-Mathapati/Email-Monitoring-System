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
            console.warn("Dashboard API called without currentEmail.");
            return res.status(400).json([]);
        }

        const cards = await dbService.getDashboardCards(email);
        console.log(`[API] Serving ${cards.length} cards to dashboard for ${email}`);
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

// 2. APPROVE ROUTE: Implements Requirement 8 (Dependent Adjustment / Stacking)
app.post("/api/tasks/approve", async (req, res) => {
    const { id } = req.body;
    try {
        const currentTask = await dbService.getTaskById(id);

        if (!currentTask) {
            return res.status(404).json({ error: "Task not found" });
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

            // FORCE CHECK: If Delta gave us nothing, let's look for existing messages manually once
            if (emails.length === 0) {
                const token = await tokenManager.getAccessToken();
                const historyRes = await axios.get("https://graph.microsoft.com/v1.0/me/messages?$top=10", {
                    headers: { Authorization: `Bearer ${token}` }
                });
                emails = historyRes.data.value;
            }

            // 1. Get the tracking date you set in Signup
            const userRes = await pool.query("SELECT tracking_start_date FROM users WHERE email = $1", [tokenManager.currentEmail]);
            if (!userRes.rows[0]) return;
            const trackingStartDate = new Date(userRes.rows[0].tracking_start_date);

            for (const email of emails) {
                const emailTime = new Date(email.receivedDateTime);

                // GATE 1: Ignore emails older than your tracking time (e.g., ignore before 1:30 AM)
                if (emailTime < trackingStartDate) continue;

                // GATE 2: Duplicate check
                if (await dbService.isEmailProcessed(email.id)) continue;

                console.log(`\n[NEW EMAIL] Analyzed: ${email.subject}`);
                const aiResponse = await aiService.analyzeEmail(email.subject, email.bodyPreview);
                
                if (aiResponse?.tasks) {
                    for (const t of aiResponse.tasks) {
                        // PASS the email.receivedDateTime to the DB
                        await dbService.saveTask(email.id, email.subject, aiResponse.overall_summary, t, email.from.emailAddress.address, email.receivedDateTime);
                    }
                }
            }
        } catch (err) {
            console.error("Loop Error:", err.message);
        }
    }, 20000); // Checks every 20 seconds

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
