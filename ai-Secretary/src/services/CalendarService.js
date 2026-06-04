const axios = require("axios");
const tokenManager = require("../TokenManager");
const dbService = require("./DbService");
const aiService = require("./AIService");
const emailService = require("./EmailService");

class CalendarService {
    isMailboxCalendarUnavailable(err) {
        const code = err.response?.data?.error?.code;
        return code === "MailboxNotEnabledForRESTAPI";
    }

    correctRelativeSuggestedTime(aiData) {
        if (!aiData.suggested_time || aiData.suggested_time instanceof Date) {
            return aiData.suggested_time;
        }

        const sourceText = [
            aiData.action_item,
            aiData.task_description,
            aiData.description
        ].filter(Boolean).join(" ");
        const intent = (aiData.intent || "").toLowerCase();
        const hasDateReference = /\b(next|this|coming|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|eod|end of day)\b/i.test(sourceText);

        if (intent !== "schedule" && !/^\s*(schedule|set up|arrange|book)\b/i.test(aiData.action_item || "") && !hasDateReference) {
            console.log(`[SCHEDULER TIME FIX] Ignoring unsupported suggested_time for non-scheduling task "${aiData.action_item}".`);
            return null;
        }

        if (!/\b(next|this|coming|today|tomorrow)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(sourceText)) {
            return aiData.suggested_time;
        }

        const corrected = aiService.parseSuggestedTime(sourceText, aiService.getReferenceDate(aiData.received_at));
        if (corrected && corrected !== aiData.suggested_time) {
            console.log(`[SCHEDULER TIME FIX] Corrected stale suggested_time from ${aiData.suggested_time} to ${corrected}`);
            return corrected;
        }

        return aiData.suggested_time;
    }

    async hydrateScheduleTaskFromEmail(aiData) {
        const intent = (aiData.intent || "").toLowerCase();
        if (!aiData.email_id || (intent !== "schedule" && !/^\s*(schedule|set up|arrange|book)\b/i.test(aiData.action_item || ""))) {
            return aiData;
        }

        const body = await emailService.fetchMessageBody(aiData.email_id);
        if (!body) return aiData;

        const extractedTasks = aiService.extractDeterministicTasks(aiData.subject, body, aiData.sender_email, aiData.received_at);
        const scheduleTask = extractedTasks.find(task => task.intent === "schedule" || /schedule|meeting/i.test(task.action_item || ""));
        if (!scheduleTask) return aiData;

        if (scheduleTask.suggested_time && scheduleTask.suggested_time !== aiData.suggested_time) {
            console.log(`[SCHEDULER EMAIL FIX] Rebuilt schedule task from original email: ${scheduleTask.action_item} at ${scheduleTask.suggested_time}`);
        }

        return {
            ...aiData,
            action_item: scheduleTask.action_item || aiData.action_item,
            priority: scheduleTask.priority || aiData.priority,
            suggested_time: scheduleTask.suggested_time || aiData.suggested_time,
            duration: scheduleTask.duration || aiData.duration,
            duration_minutes: scheduleTask.duration || aiData.duration_minutes,
            task_description: scheduleTask.description || aiData.task_description
        };
    }

    // 1. THE MAIN FUNCTION CALLED BY APP.JS
    async scheduleTask(aiData) {
        try {
            const token = await tokenManager.getAccessToken();
            aiData = await this.hydrateScheduleTaskFromEmail(aiData);
            
            // Normalize duration from AI data or database row
            const durationMinutes = aiData.duration ?? aiData.duration_minutes ?? 30;

            // Determine requested start (use AI-extracted time or default to now)
            let requestedStart;
            const suggestedTime = this.correctRelativeSuggestedTime(aiData);
            if (suggestedTime) {
                // Parse the ISO time as IST (no conversion, keep as IST)
                try {
                    requestedStart = this.parseIST(suggestedTime);
                    if (!requestedStart || isNaN(requestedStart.getTime())) {
                        throw new Error("Invalid date after parsing");
                    }
                    const istDisplay = requestedStart.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
                    console.log(`[AI-EXTRACTED TIME] ${suggestedTime} IST (keeping as IST, no conversion)`);
                    console.log(`[DISPLAY] Calendar will show: ${istDisplay} IST`);
                } catch (parseErr) {
                    console.warn(`[PARSE ERROR] Could not parse suggested_time: ${parseErr.message}, using current time`);
                    requestedStart = new Date();
                }
            } else {
                requestedStart = new Date();
                const istDisplay = requestedStart.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
                console.log(`[DEFAULT TIME] No time specified, using current time: ${istDisplay} IST`);
            }
            
            // Ensure we are working with the correct year (2026)
            const requestedParts = this.getISTParts(requestedStart);
            if (requestedParts.year !== 2026) {
                console.log(`[YEAR CORRECTION] Year was ${requestedParts.year}, setting to 2026`);
                
                const pad = n => String(n).padStart(2, "0");
                const correctedISTStr = `2026-${pad(requestedParts.month)}-${pad(requestedParts.day)}T${pad(requestedParts.hour)}:${pad(requestedParts.minute)}:${pad(requestedParts.second)}`;
                requestedStart = this.parseIST(correctedISTStr);
            }

            console.log(`[CHECKING] Looking for conflicts at ${this.formatIST(requestedStart)} IST...`);

            // 2. RUN PRIORITY-AWARE CONFLICT DETECTION
            const scheduleDecision = await this.findPriorityAwareSlot(requestedStart, durationMinutes, aiData);
            const finalStartTime = scheduleDecision.start;
            
            if (finalStartTime.getTime() !== requestedStart.getTime()) {
                console.log(`[RESCHEDULED] Conflict found! Moving from ${this.formatIST(requestedStart)} IST to: ${this.formatIST(finalStartTime)} IST`);
            } else {
                console.log(`[CONFIRMED] No conflicts. Scheduling at: ${this.formatIST(finalStartTime)} IST`);
            }

            scheduleDecision.reasoning.forEach(line => console.log(`[PRIORITY DECISION] ${line}`));

            const endTime = new Date(finalStartTime.getTime() + durationMinutes * 60000);
            const participantList = (Array.isArray(aiData.participants) ? aiData.participants : [])
                .map(participant => String(participant).trim())
                .filter(Boolean);
            const validAttendees = participantList
                .filter(participant => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(participant))
                .map(address => ({
                    emailAddress: { address },
                    type: "required"
                }));

            // 3. THE ACTUAL API CALL - USING IST TIMEZONE
            const eventPayload = {
                subject: `AI AGENT: ${aiData.action_item}`,
                body: {
                    contentType: "HTML",
                    content: `<b>Summary:</b> ${aiData.summary || aiData.task_description || aiData.action_item}<br/>${participantList.length ? `<b>Participants mentioned:</b> ${participantList.join(", ")}<br/>` : ""}<i>Scheduled by AI Secretary.</i>`
                },
                start: {
                    dateTime: this.getISTLocalString(finalStartTime),
                    timeZone: "India Standard Time"
                },
                end: {
                    dateTime: this.getISTLocalString(endTime),
                    timeZone: "India Standard Time"
                },
                location: { displayName: "AI Office" }
            };
            if (validAttendees.length > 0) {
                eventPayload.attendees = validAttendees;
            }

            let eventId = null;
            try {
                const response = await axios.post(
                    "https://graph.microsoft.com/v1.0/me/events",
                    eventPayload,
                    {
                        headers: {
                            Authorization: `Bearer ${token}`,
                            "Content-Type": "application/json",
                            "Prefer": 'outlook.timezone="India Standard Time"'
                        }
                    }
                );

                eventId = response.data.id;
                console.log(`[SUCCESS] Event created in Outlook! ID: ${eventId.substring(0, 10)}...`);
            } catch (err) {
                if (!this.isMailboxCalendarUnavailable(err)) {
                    throw err;
                }

                eventId = `local-${Date.now()}`;
                console.warn("[CALENDAR FALLBACK] Microsoft Graph Calendar is not available for this mailbox. Saved schedule locally only.");
            }

            console.log(`[CALENDAR] Event scheduled: "${aiData.action_item}" on ${finalStartTime.toDateString()} at ${finalStartTime.toLocaleTimeString()}`);
            
            return {
                eventId,
                start: finalStartTime,
                end: endTime,
                decisionLog: scheduleDecision.reasoning
            };

        } catch (err) {
            console.error("Critical Scheduling Error:", err.response?.data || err.message);
            return null;
        }
    }

    async updateCalendarEvent(task, newTime) {
        const hydratedTask = await this.hydrateScheduleTaskFromEmail({
            ...task,
            suggested_time: newTime || task.suggested_time
        });
        const durationMinutes = hydratedTask.duration ?? hydratedTask.duration_minutes ?? 30;
        const requestedStart = this.parseIST(this.correctRelativeSuggestedTime(hydratedTask));
        const scheduleDecision = await this.findPriorityAwareSlot(requestedStart, durationMinutes, hydratedTask);
        const finalStartTime = scheduleDecision.start;
        const endTime = new Date(finalStartTime.getTime() + durationMinutes * 60000);

        if (!task.outlook_event_id || String(task.outlook_event_id).startsWith("local-")) {
            return {
                eventId: task.outlook_event_id || `local-${Date.now()}`,
                start: finalStartTime,
                end: endTime,
                decisionLog: scheduleDecision.reasoning
            };
        }

        const token = await tokenManager.getAccessToken();
        await axios.patch(
            `https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(task.outlook_event_id)}`,
            {
                start: {
                    dateTime: this.getISTLocalString(finalStartTime),
                    timeZone: "India Standard Time"
                },
                end: {
                    dateTime: this.getISTLocalString(endTime),
                    timeZone: "India Standard Time"
                }
            },
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json",
                    "Prefer": 'outlook.timezone="India Standard Time"'
                }
            }
        );

        return {
            eventId: task.outlook_event_id,
            start: finalStartTime,
            end: endTime,
            decisionLog: scheduleDecision.reasoning
        };
    }

    async cancelMeeting(task) {
        if (!task.outlook_event_id || String(task.outlook_event_id).startsWith("local-")) {
            console.log(`[CANCEL] No Outlook event to cancel for task "${task.action_item}"`);
            return { success: true, localOnly: true };
        }

        try {
            const token = await tokenManager.getAccessToken();
            await axios.delete(
                `https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(task.outlook_event_id)}`,
                { headers: { Authorization: `Bearer ${token}` } }
            );
            console.log(`[CANCEL] Outlook event deleted for: "${task.action_item}"`);
            return { success: true };
        } catch (err) {
            if (err.response?.status === 404) {
                console.warn(`[CANCEL] Event already deleted from calendar: "${task.action_item}"`);
                return { success: true };
            }
            console.error("[CANCEL] Failed to delete Outlook event:", err.response?.data || err.message);
            return { success: false, error: err.message };
        }
    }

    // PARSE IST TIME - Converts IST ISO string to exact UTC Date object
    parseIST(istTimeString) {
        if (!istTimeString) {
            console.warn("[TIMEZONE] Warning: istTimeString is null/undefined, using current time");
            return new Date();
        }

        if (istTimeString instanceof Date) {
            return istTimeString;
        }

        const timeStr = String(istTimeString).trim();
        
        try {
            // Parse date components from ISO string like "2026-04-30T10:00:00"
            const [datePart, timePart] = timeStr.split('T');
            const [year, month, day] = datePart.split('-').map(Number);
            const [hour, minute, second] = (timePart || '10:00:00').split(':').map(Number);
            
            if (!year || !month || !day) {
                console.warn(`[TIMEZONE] Invalid date format: ${timeStr}`);
                return new Date();
            }
            
            // Create a Date object in UTC by treating these components as UTC
            const utcDate = new Date(Date.UTC(year, month - 1, day, hour || 10, minute || 0, second || 0));
            // Convert IST to UTC by subtracting 5.5 hours (330 minutes)
            utcDate.setMinutes(utcDate.getMinutes() - 330);
            
            return utcDate;
        } catch (e) {
            console.error(`[TIMEZONE] Error parsing ${timeStr}:`, e.message);
            return new Date();
        }
    }

    getISTParts(date) {
        const formatter = new Intl.DateTimeFormat("en-US", {
            timeZone: "Asia/Kolkata",
            year: "numeric",
            month: "numeric",
            day: "numeric",
            hour: "numeric",
            minute: "numeric",
            second: "numeric",
            hour12: false
        });
        const partsList = formatter.formatToParts(date);
        const parts = {};
        for (const p of partsList) {
            parts[p.type] = p.value;
        }
        return {
            year: Number(parts.year),
            month: Number(parts.month),
            day: Number(parts.day),
            hour: Number(parts.hour),
            minute: Number(parts.minute),
            second: Number(parts.second)
        };
    }

    formatIST(date) {
        return date.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
    }

    getISTLocalString(date) {
        const parts = this.getISTParts(date);
        const pad = n => String(n).padStart(2, "0");
        return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
    }

    isWorkingDayExhausted(date, durationMinutes) {
        const parts = this.getISTParts(date);
        const endHourDecimal = parts.hour + (parts.minute + durationMinutes) / 60;
        return endHourDecimal > 22 || parts.hour < 9; // Outside 9 AM to 10 PM IST
    }

    moveToNextWorkingDayStart(date) {
        const temp = new Date(date);
        temp.setDate(temp.getDate() + 1);
        const nextParts = this.getISTParts(temp);
        
        const pad = n => String(n).padStart(2, "0");
        const nextDayISTString = `${nextParts.year}-${pad(nextParts.month)}-${pad(nextParts.day)}T09:00:00`;
        return this.parseIST(nextDayISTString);
    }

    // TIMEZONE DETECTION: Detect timezone from sender email domain or header
    detectSenderTimezone(fromEmail, emailHeaders = {}) {
        // Check email headers for timezone info
        if (emailHeaders.x_mailer) {
            if (emailHeaders.x_mailer.includes('India') || emailHeaders.x_mailer.includes('IST')) {
                console.log(`[TIMEZONE DETECT] Sender using IST (from email header)`);
                return 'Asia/Kolkata';
            }
        }

        // Check email domain heuristics
        if (fromEmail) {
            const domain = fromEmail.split('@')[1]?.toLowerCase() || '';
            if (domain.includes('.in') || domain.includes('india')) {
                console.log(`[TIMEZONE DETECT] Sender from India domain: ${domain} -> IST`);
                return 'Asia/Kolkata';
            }
            if (domain.includes('.uk') || domain.includes('london')) {
                console.log(`[TIMEZONE DETECT] Sender from UK domain: ${domain} -> GMT`);
                return 'Europe/London';
            }
            if (domain.includes('.us') || domain.includes('usa')) {
                console.log(`[TIMEZONE DETECT] Sender from US domain: ${domain} -> EST`);
                return 'America/New_York';
            }
        }

        // Default to IST
        console.log(`[TIMEZONE DETECT] No sender timezone info found, defaulting to IST`);
        return 'Asia/Kolkata';
    }

    // LOCALIZE TIME FOR PARTICIPANT: Convert IST to participant's timezone
    localizeTimeForParticipant(istTime, participantTimezone) {
        if (!participantTimezone) participantTimezone = 'Asia/Kolkata';
        
        try {
            const participantTime = istTime.toLocaleString('en-US', { timeZone: participantTimezone });
            return {
                timezone: participantTimezone,
                localTime: participantTime,
                iso: istTime.toISOString()
            };
        } catch (e) {
            console.error(`[TIMEZONE] Error localizing for ${participantTimezone}:`, e.message);
            return {
                timezone: participantTimezone,
                localTime: istTime.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
                iso: istTime.toISOString()
            };
        }
    }

    // BUILD PARTICIPANT TIMEZONE INFO FOR EMAIL BODY
    buildParticipantTimezoneInfo(senderEmail, receiverEmail, eventTime) {
        const senderTz = this.detectSenderTimezone(senderEmail);
        const receiverTz = this.detectSenderTimezone(receiverEmail);
        
        const senderTime = this.localizeTimeForParticipant(eventTime, senderTz);
        const receiverTime = this.localizeTimeForParticipant(eventTime, receiverTz);
        
        return {
            sender: { email: senderEmail, ...senderTime },
            receiver: { email: receiverEmail, ...receiverTime },
            original_ist: eventTime.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
        };
    }

    getPriorityScore(priority) {
        const normalized = (priority || "Medium").toString().trim().toLowerCase();
        if (normalized === "high") return 3;
        if (normalized === "low") return 1;
        return 2;
    }

    getEventPriority(calEvent, task) {
        if (task?.priority) return task.priority;

        const importance = (calEvent.importance || "").toLowerCase();
        if (importance === "high") return "High";
        if (importance === "low") return "Low";
        return "Medium";
    }

    getEventId(calEvent) {
        return calEvent.id || calEvent.iCalUId || calEvent.subject || "";
    }

    getEventStart(calEvent) {
        return this.parseIST(calEvent.start.dateTime);
    }

    getEventEnd(calEvent) {
        return this.parseIST(calEvent.end.dateTime);
    }

    overlaps(startA, endA, startB, endB) {
        return startA < endB && endA > startB;
    }

    async getCalendarEvents(startWindow, endWindow) {
        const token = await tokenManager.getAccessToken();
        try {
            const response = await axios.get(
                `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${startWindow.toISOString()}&endDateTime=${endWindow.toISOString()}`,
                { 
                    headers: { 
                        Authorization: `Bearer ${token}`,
                        "Prefer": 'outlook.timezone="India Standard Time"' 
                    } 
                }
            );

            return response.data.value || [];
        } catch (err) {
            if (this.isMailboxCalendarUnavailable(err)) {
                console.warn("[CALENDAR FALLBACK] Cannot read Outlook calendar for this mailbox. Continuing without conflict lookup.");
                return [];
            }
            throw err;
        }
    }

    async getEventsForDay(start) {
        const parts = this.getISTParts(start);
        const pad = n => String(n).padStart(2, "0");
        
        const startISTStr = `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T00:00:00`;
        const endISTStr = `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T23:59:59`;
        
        const startWindow = this.parseIST(startISTStr);
        const endWindow = this.parseIST(endISTStr);
        
        return this.getCalendarEvents(startWindow, endWindow);
    }

    async enrichConflict(calEvent) {
        const task = await dbService.getTaskByOutlookEventId(calEvent.id);
        const priority = this.getEventPriority(calEvent, task);

        return {
            calEvent,
            task,
            priority,
            priorityScore: this.getPriorityScore(priority),
            start: this.getEventStart(calEvent),
            end: this.getEventEnd(calEvent),
            subject: calEvent.subject || task?.action_item || "Untitled meeting"
        };
    }

    async getConflicts(candidateStart, durationMinutes, ignoredEventIds = new Set(), reservedSlots = []) {
        const candidateEnd = new Date(candidateStart.getTime() + durationMinutes * 60000);
        const events = await this.getEventsForDay(candidateStart);
        const conflicts = [];

        for (const calEvent of events) {
            const eventId = this.getEventId(calEvent);
            if (ignoredEventIds.has(eventId)) continue;

            const eventStart = this.getEventStart(calEvent);
            const eventEnd = this.getEventEnd(calEvent);
            if (this.overlaps(candidateStart, candidateEnd, eventStart, eventEnd)) {
                conflicts.push(await this.enrichConflict(calEvent));
            }
        }

        for (const slot of reservedSlots) {
            if (this.overlaps(candidateStart, candidateEnd, slot.start, slot.end)) {
                conflicts.push({
                    calEvent: null,
                    task: null,
                    priority: "Reserved",
                    priorityScore: 99,
                    start: slot.start,
                    end: slot.end,
                    subject: slot.subject || "Reserved reschedule slot"
                });
            }
        }

        return conflicts.sort((a, b) => a.start - b.start);
    }

    async findNextAvailableSlot(requestedStart, durationMinutes, ignoredEventIds = new Set(), reservedSlots = []) {
        let potentialStart = new Date(requestedStart);
        const reasoning = [];

        while (true) {
            if (this.isWorkingDayExhausted(potentialStart, durationMinutes)) {
                reasoning.push(`Working day exhausted or outside limits at ${this.formatIST(potentialStart)} IST; checking next day at 9:00 AM IST.`);
                potentialStart = this.moveToNextWorkingDayStart(potentialStart);
            }

            const conflicts = await this.getConflicts(potentialStart, durationMinutes, ignoredEventIds, reservedSlots);
            if (conflicts.length === 0) {
                return { start: potentialStart, reasoning };
            }

            const latestConflictEnd = conflicts.reduce((latest, conflict) => {
                return conflict.end > latest ? conflict.end : latest;
            }, conflicts[0].end);

            reasoning.push(`Next best slot check skipped ${conflicts.length} conflict(s); moving after ${this.formatIST(latestConflictEnd)} IST.`);
            potentialStart = new Date(latestConflictEnd.getTime() + 5 * 60000);
        }
    }

    async rescheduleCalendarEvent(conflict, newStart, durationMinutes) {
        if (!conflict.calEvent?.id) {
            throw new Error(`Cannot reschedule "${conflict.subject}" because it has no Outlook event id.`);
        }

        const token = await tokenManager.getAccessToken();
        const newEnd = new Date(newStart.getTime() + durationMinutes * 60000);
        const payload = {
            start: {
                dateTime: this.getISTLocalString(newStart),
                timeZone: "India Standard Time"
            },
            end: {
                dateTime: this.getISTLocalString(newEnd),
                timeZone: "India Standard Time"
            }
        };

        await axios.patch(
            `https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(conflict.calEvent.id)}`,
            payload,
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json",
                    "Prefer": 'outlook.timezone="India Standard Time"'
                }
            }
        );

        if (conflict.task?.id) {
            await dbService.updateTaskScheduleTimes(conflict.task.id, newStart, newEnd);
        }

        return { start: newStart, end: newEnd };
    }

    async rescheduleLowerPriorityConflicts(conflicts, incomingEnd, durationMinutes, incomingEventId, reasoning) {
        const ignoredEventIds = new Set([incomingEventId].filter(Boolean));
        const reservedSlots = [{ start: new Date(incomingEnd.getTime() - durationMinutes * 60000), end: incomingEnd, subject: "Incoming higher-priority meeting" }];
        let searchStart = new Date(incomingEnd.getTime() + 5 * 60000);

        for (const conflict of conflicts.sort((a, b) => a.start - b.start)) {
            const conflictDuration = Math.max(15, Math.round((conflict.end - conflict.start) / 60000));
            ignoredEventIds.add(this.getEventId(conflict.calEvent));

            const nextSlot = await this.findNextAvailableSlot(searchStart, conflictDuration, ignoredEventIds, reservedSlots);
            nextSlot.reasoning.forEach(line => reasoning.push(`For "${conflict.subject}": ${line}`));

            const moved = await this.rescheduleCalendarEvent(conflict, nextSlot.start, conflictDuration);
            reservedSlots.push({ start: moved.start, end: moved.end, subject: conflict.subject });
            searchStart = new Date(moved.end.getTime() + 5 * 60000);
            reasoning.push(`Rescheduled lower-priority "${conflict.subject}" (${conflict.priority}) to ${moved.start.toLocaleString()}.`);
        }
    }

    async findPriorityAwareSlot(requestedStart, durationMinutes, aiData) {
        const incomingPriority = aiData.priority || "Medium";
        const incomingPriorityScore = this.getPriorityScore(incomingPriority);
        const reasoning = [`Incoming meeting "${aiData.action_item}" is ${incomingPriority} priority.`];
        let potentialStart = new Date(requestedStart);

        while (true) {
            const taskEnd = new Date(potentialStart.getTime() + durationMinutes * 60000);
            const conflicts = await this.getConflicts(potentialStart, durationMinutes);

            if (conflicts.length === 0) {
                reasoning.push(`No conflicts found at ${potentialStart.toLocaleString()}; keeping requested slot.`);
                return { start: potentialStart, reasoning };
            }

            conflicts.forEach(conflict => {
                reasoning.push(`Conflict: "${conflict.subject}" from ${conflict.start.toLocaleString()} to ${conflict.end.toLocaleString()} is ${conflict.priority} priority.`);
            });

            const blockingConflicts = conflicts.filter(conflict => conflict.priorityScore >= incomingPriorityScore);

            if (blockingConflicts.length === 0) {
                reasoning.push(`Incoming ${incomingPriority} priority outranks all ${conflicts.length} conflict(s); keeping requested slot and moving lower-priority meeting(s).`);
                await this.rescheduleLowerPriorityConflicts(conflicts, taskEnd, durationMinutes, null, reasoning);
                return { start: potentialStart, reasoning };
            }

            const latestBlockingEnd = blockingConflicts.reduce((latest, conflict) => {
                return conflict.end > latest ? conflict.end : latest;
            }, blockingConflicts[0].end);

            reasoning.push(`${blockingConflicts.length} same-or-higher priority conflict(s) block the requested slot; searching after ${latestBlockingEnd.toLocaleString()}.`);
            potentialStart = new Date(latestBlockingEnd.getTime() + 5 * 60000);

            if (this.isWorkingDayExhausted(potentialStart, durationMinutes)) {
                reasoning.push(`No suitable slot remains today at ${this.formatIST(potentialStart)} IST; moving search to tomorrow at 9:00 AM IST.`);
                potentialStart = this.moveToNextWorkingDayStart(potentialStart);
            }
        }
    }

    // 5. THE CONFLICT DETECTION ENGINE
    async findFreeSlot(requestedStart, durationMinutes) {
        const token = await tokenManager.getAccessToken();
        const endWindow = new Date(requestedStart);
        endWindow.setHours(23, 59, 59);

        const response = await axios.get(
            `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${requestedStart.toISOString()}&endDateTime=${endWindow.toISOString()}`,
            { 
                headers: { 
                    Authorization: `Bearer ${token}`,
                    "Prefer": 'outlook.timezone="India Standard Time"' 
                } 
            }
        );

        const events = response.data.value;
        let potentialStart = new Date(requestedStart);

        for (const calEvent of events) {
            const eventStart = new Date(calEvent.start.dateTime);
            const eventEnd = new Date(calEvent.end.dateTime);
            const taskEnd = new Date(potentialStart.getTime() + durationMinutes * 60000);

            // If overlap exists
            if (potentialStart < eventEnd && taskEnd > eventStart) {
                console.log(`[DEBUG] Conflict with "${calEvent.subject}".`);
                potentialStart = new Date(eventEnd.getTime() + 5 * 60000); // 5 min buffer
            }
        }

        // Working Hours logic (9 AM - 10 PM IST)
        if (this.isWorkingDayExhausted(potentialStart, durationMinutes)) {
            console.log("[DAY FULL] Pushing search to tomorrow at 9:00 AM IST...");
            potentialStart = this.moveToNextWorkingDayStart(potentialStart);
            return this.findFreeSlot(potentialStart, durationMinutes);
        }

        return potentialStart;
    }
}

module.exports = new CalendarService();
