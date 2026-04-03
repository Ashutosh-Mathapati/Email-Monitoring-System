const express = require("express");
const router = express.Router();
const dbService = require("../services/DbService");
const calendarService = require("../services/CalendarService");

router.get("/dashboard", async (req, res) => {
    try {
        const data = await dbService.getDashboardCards();
        res.json(data);
    } catch (err) {
        console.error("Dashboard Error:", err.message);
        res.status(500).json({ error: "Unable to load dashboard cards." });
    }
});

router.post("/approve/:id", async (req, res) => {
    try {
        const task = await dbService.getTaskById(req.params.id);

        if (!task) {
            return res.status(404).json({ success: false, error: "Task not found." });
        }

        const schedule = await calendarService.scheduleTask(task);

        if (!schedule) {
            return res.status(500).json({ success: false, error: "Unable to schedule task." });
        }

        await dbService.updateScheduledTask(task.id, schedule.eventId, schedule.start, schedule.end);
        res.json({ success: true });
    } catch (err) {
        console.error("Approve Error:", err.message);
        res.status(500).json({ success: false, error: "Approval failed." });
    }
});

module.exports = router;
