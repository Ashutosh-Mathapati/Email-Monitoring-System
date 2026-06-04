# Event Scheduling Timezone Issue - FIX GUIDE

## Problem Identified
**Issue**: Event scheduled for "5:30 am" in email but shows as "12:30 am" in calendar. Should actually be "11 am".

### Root Cause
There were TWO issues:

1. **Timezone Conversion Bug**: 
   - The system was sending IST-converted times with "India Standard Time" timezone, causing double conversion
   - Old code converted IST → UTC, then told Outlook it was IST, confusing the calendar
   - Result: Time was off by approximately 5.5 hours

2. **AI Time Extraction Issue** (possible):
   - The email may have said "11 am" but AI extracted it as "5:30 am"
   - OR the email actually says "5:30 am" but should have been "11 am"

## Solution Implemented

### 1. **Fixed CalendarService.js Timezone Handling**
- Updated `convertIST_toUTC()` to properly parse ISO strings as IST (not UTC)
- Changed event payload to use UTC timezone explicitly
- Removed conflicting "India Standard Time" timezone from the API call

### 2. **Added Time Correction Endpoint**
- New API: `POST /api/tasks/correct-time/:id`
- Allows correcting extracted times before scheduling

### 3. **Improved Logging**
- Now displays what time will actually appear in calendar (IST)
- Shows conversion math: Input (IST) → UTC → Display Time

## How to Fix the "5:30 am → 11 am" Issue

### Option A: Correct the Time Before Scheduling

**Using the new API:**
```bash
curl -X POST http://localhost:5000/api/tasks/correct-time/TASK_ID \
  -H "Content-Type: application/json" \
  -d '{"newTime": "2026-05-01T11:00:00"}'
```

Replace `TASK_ID` with the actual task ID from the database.

**In the dashboard:**
1. Look at the task that says "5:30 am"
2. Call the correction endpoint before clicking "Approve"
3. Set new time to "2026-05-01T11:00:00" (11 am IST)
4. Then click "Approve" to schedule

### Option B: Manually Update Database
```sql
UPDATE tasks 
SET suggested_time = '2026-05-01T11:00:00' 
WHERE id = TASK_ID 
AND action_item LIKE '%Client Review Meeting%';
```

### Option C: Verify the Original Email
Check the original email from the sender:
1. Does it say "5:30 am" or "11 am"?
2. If it says "5:30 am": The extraction was correct, but the email might have a typo
3. If it says "11 am": Update the database with `2026-05-01T11:00:00`

## Time Display Format

All times in `suggested_time` should be in **ISO 8601 format (24-hour clock)**:
- Format: `YYYY-MM-DDTHH:mm:ss`
- Example: `2026-05-01T11:00:00` (11 am IST)
- Example: `2026-05-01T05:30:00` (5:30 am IST)

## Verification

After scheduling, the calendar should show:
- **Input**: 11 am IST
- **Stored in UTC**: 5:30 am UTC  
- **Display in Calendar**: 11 am IST ✓

### Check the Scheduled Event

Get task details to verify what was scheduled:
```bash
curl http://localhost:5000/api/tasks/TASK_ID
```

Look for `suggested_time` field - it should show the time you intended (in IST).

## Database Query to Check All Extracted Times

```sql
SELECT id, action_item, suggested_time, status 
FROM tasks 
WHERE suggested_time IS NOT NULL 
ORDER BY suggested_time DESC;
```

This shows all tasks with extracted times so you can verify they're correct.

## Notes for Future Emails

The AI now extracts times from emails with these rules:
- Time must be explicit in the email (e.g., "at 11 am" or "3:00 pm")
- Dates must include year or be clearly within 2026
- Default time is 10:00 am if only date is mentioned
- All times are assumed to be IST unless explicitly stated as UTC/EST/etc.

Example email formats that work:
- ✓ "Schedule meeting for May 1 at 11 am"
- ✓ "May 1, 2026 at 11:00 AM"  
- ✓ "Friday May 1 @ 11:00"
- ✗ "Schedule meeting sometime next week" (no specific time)
