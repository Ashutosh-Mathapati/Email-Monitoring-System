require("dotenv").config();
const pool = require("./src/db");

async function runMigration() {
    try {
        console.log("[MIGRATION] Adding task_description and task_order columns...");
        
        const result = await pool.query(`
            ALTER TABLE tasks ADD COLUMN IF NOT EXISTS task_description TEXT;
            ALTER TABLE tasks ADD COLUMN IF NOT EXISTS task_order INTEGER DEFAULT 0;
        `);
        
        console.log("[SUCCESS] Columns added successfully!");
        
        // Verify the columns exist
        const checkResult = await pool.query(`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name='tasks' AND (column_name='task_description' OR column_name='task_order')
        `);
        
        console.log("[VERIFY] Columns found:", checkResult.rows.map(r => r.column_name).join(", "));
        
        process.exit(0);
    } catch (err) {
        console.error("[ERROR] Migration failed:", err.message);
        process.exit(1);
    }
}

runMigration();
