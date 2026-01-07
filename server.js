// server.js (fixed)
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import mysql from "mysql2/promise";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// ---------------------------
// Database Connection
// ---------------------------
let db;
try {
  db = await mysql.createConnection({
    host: process.env.DB_HOST || "localhost",
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASS || "12345",
    database: process.env.DB_NAME || "exam_seating",
  });
  console.log("✅ Connected to database");
} catch (err) {
  console.error("❌ Database connection failed:", err.message);
  process.exit(1);
}

// ---------------------------
// Simple helpers
// ---------------------------
const placeholdersSafe = (arr) => {
  if (!Array.isArray(arr) || arr.length === 0) return "NULL";
  return arr.map(() => "?").join(",");
};

const ensureArray = (v) => {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  return [v];
};

// ---------------------------
// GET test
// ---------------------------
app.get("/", (req, res) => {
  res.send("Backend running!");
});

// ---------------------------
// GET rooms
// ---------------------------
app.get("/rooms", async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM rooms ORDER BY id");
    res.json(rows);
  } catch (err) {
    console.error("Error /rooms:", err);
    res.status(500).json({ error: "Failed to fetch rooms" });
  }
});

// ---------------------------
// GET semesters
// ---------------------------
app.get("/semesters", async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM semesters ORDER BY id");
    res.json(rows);
  } catch (err) {
    console.error("Error /semesters:", err);
    res.status(500).json({ error: "Failed to fetch semesters" });
  }
});

// ---------------------------
// POST /api/generate-plan
// ---------------------------
app.post("/api/generate-plan", async (req, res) => {
  try {
    // Accept either arrays or undefined safely
    let { selectedRooms, selectedBatches } = req.body || {};

    selectedRooms = ensureArray(selectedRooms).map((x) => Number(x)).filter(Number.isFinite);
    selectedBatches = ensureArray(selectedBatches).map((x) => String(x).trim()).filter((s) => s.length > 0);

    if (!selectedRooms.length) return res.status(400).json({ error: "No rooms selected." });
    if (!selectedBatches.length) return res.status(400).json({ error: "No batches selected." });

    // Fetch selected rooms (by id)
    const sqlRooms = `SELECT * FROM rooms WHERE id IN (${placeholdersSafe(selectedRooms)}) ORDER BY id`;
    const [roomRows] = await db.execute(sqlRooms, selectedRooms);
    if (!roomRows || roomRows.length === 0) return res.status(404).json({ error: "Selected rooms not found." });

    // NOTE: your DB has semesters.title (not subtitle). Use title.
    const sqlSem = `SELECT id, title FROM semesters WHERE title IN (${placeholdersSafe(selectedBatches)})`;
    const [semRows] = await db.execute(sqlSem, selectedBatches);
    if (!semRows || semRows.length === 0) {
      return res.status(404).json({ error: "Selected semester batch titles do not exist in DB." });
    }
    const semesterIDs = semRows.map((r) => Number(r.id)).filter(Number.isFinite);
    if (!semesterIDs.length) return res.status(400).json({ error: "Resolved semester IDs invalid." });

    // Fetch students for those semester IDs
    const sqlStudents = `
      SELECT s.id, s.full_name AS student, s.roll_no AS rollNo, s.department, s.batch, sem.title AS semester
      FROM students s
      JOIN semesters sem ON s.semester_id = sem.id
      WHERE s.semester_id IN (${placeholdersSafe(semesterIDs)})
      ORDER BY s.department, s.batch, s.roll_no
    `;
    const [studentRows] = await db.execute(sqlStudents, semesterIDs);
    if (!studentRows || studentRows.length === 0) {
      return res.status(404).json({ error: "No students found for selected batches/semesters." });
    }

    // Validate department diversity (need at least 2 departments to pair)
    const uniqueDepts = Array.from(new Set(studentRows.map((s) => s.department)));
    if (uniqueDepts.length < 2) {
      return res.status(400).json({
        error: "Selected batches contain students from only one department. Please select batches from at least two departments.",
        departments: uniqueDepts,
      });
    }

    // Build dept queues (initial)
    const deptQueues = {};
    for (const s of studentRows) {
      const d = s.department || "UNKNOWN";
      if (!deptQueues[d]) deptQueues[d] = [];
      deptQueues[d].push(s);
    }

    // Work on a mutable copy of queues
    const workingQueues = {};
    for (const k of Object.keys(deptQueues)) workingQueues[k] = [...deptQueues[k]];

    const getLargestDeptFromWorking = () => {
      let best = null;
      let bestLen = -1;
      for (const d of Object.keys(workingQueues).sort()) {
        const len = workingQueues[d].length;
        if (len > bestLen) {
          best = d;
          bestLen = len;
        }
      }
      return best;
    };

    // Build seating assignments per room (two seats per bench: seatNo odd & even)
    const assignments = [];
    let totalAssigned = 0;

    for (const room of roomRows) {
      const cap = Number(room.capacity) || 0;
      if (cap <= 0) {
        assignments.push({ room: room.name, roomId: room.id, seats: [] });
        continue;
      }

      const seats = [];
      const benches = Math.floor(cap / 2);
      let seatNo = 1;

      for (let b = 0; b < benches; b++) {
        const d1 = getLargestDeptFromWorking();
        if (!d1) break;
        const s1 = workingQueues[d1].shift();

        // pick different dept with largest count
        let d2 = null;
        let d2Len = -1;
        for (const d of Object.keys(workingQueues).sort()) {
          if (d === d1) continue;
          if (workingQueues[d].length > d2Len) {
            d2 = d;
            d2Len = workingQueues[d].length;
          }
        }
        if (!d2 || workingQueues[d2].length === 0) {
          // Not enough partner students to form a valid pair
          return res.status(400).json({
            error: `Cannot form mixed pair for room "${room.name}". Not enough students from other departments to pair with "${d1}".`,
            remaining: Object.fromEntries(Object.keys(workingQueues).map(k => [k, workingQueues[k].length]))
          });
        }
        const s2 = workingQueues[d2].shift();

        seats.push({
          seatNo,
          student: s1.student,
          rollNo: s1.rollNo,
          department: s1.department,
          batch: s1.batch,
          semester: s1.semester
        });
        seats.push({
          seatNo: seatNo + 1,
          student: s2.student,
          rollNo: s2.rollNo,
          department: s2.department,
          batch: s2.batch,
          semester: s2.semester
        });
        seatNo += 2;
        totalAssigned += 2;
      }

      // if odd capacity, allow one single seat at end
      if (cap % 2 === 1 && seatNo <= cap) {
        const dAny = getLargestDeptFromWorking();
        if (dAny && workingQueues[dAny].length > 0) {
          const s = workingQueues[dAny].shift();
          seats.push({
            seatNo,
            student: s.student,
            rollNo: s.rollNo,
            department: s.department,
            batch: s.batch,
            semester: s.semester
          });
          seatNo++;
          totalAssigned++;
        }
      }

      assignments.push({ room: room.name, roomId: room.id, seats });
      // if no students left, break early
      const remaining = Object.keys(workingQueues).reduce((acc, k) => acc + workingQueues[k].length, 0);
      if (remaining === 0) break;
    }

    if (totalAssigned === 0) {
      return res.status(400).json({ error: "No seats were assigned (not enough students or capacity)." });
    }

    // Persist assignments: delete only affected rooms and insert new rows
    try {
      await db.beginTransaction();

      const roomNames = assignments.map((r) => r.room).filter(Boolean);
      if (roomNames.length > 0) {
        const sqlDel = `DELETE FROM seating_plan WHERE room IN (${placeholdersSafe(roomNames)})`;
        await db.execute(sqlDel, roomNames);
      }

      const insertSQL = `
        INSERT INTO seating_plan (room, seatNo, student, rollNo, department, batch, semester)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `;
      for (const a of assignments) {
        for (const s of a.seats) {
          await db.execute(insertSQL, [
            a.room,
            String(s.seatNo),
            s.student,
            s.rollNo,
            s.department,
            s.batch,
            s.semester
          ]);
        }
      }

      await db.commit();
    } catch (e) {
      await db.rollback();
      console.error("Persist error:", e);
      return res.status(500).json({ error: "Failed to save seating plan", details: e.message });
    }

    return res.json({
      message: "Seating plan generated successfully",
      totalStudentsAvailable: studentRows.length,
      assignedStudents: totalAssigned,
      plan: assignments
    });
  } catch (err) {
    console.error("Unexpected /api/generate-plan error:", err);
    return res.status(500).json({ error: "Internal server error", details: err.message });
  }
});

// ---------------------------
// GET saved seating plan
// ---------------------------
app.get("/api/seating-plan", async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM seating_plan ORDER BY room, CAST(seatNo AS UNSIGNED)");
    res.json({ data: rows });
  } catch (err) {
    console.error("Error /api/seating-plan:", err);
    res.status(500).json({ error: "Failed to fetch seating plan" });
  }
});

// ---------------------------
// Start server
// ---------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
