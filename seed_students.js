const mysql = require("mysql2");

// MySQL connection
const db = mysql.createConnection({
  host: "localhost",
  user: "root",
  password: "12345", // apna MySQL password
  database: "exam_seating"
});

// Batches list (aap yahan count change kar sakti ho)
const batches = [
  { code: "AI-24", prefix: "AI24", count: 40 },
  { code: "AI-25", prefix: "AI25", count: 41 }, // total AI = 81
  { code: "CS-22", prefix: "CS22", count: 20 },
  { code: "CS-23", prefix: "CS23", count: 40 },
  { code: "CS-24", prefix: "CS24", count: 40 },
  { code: "CS-25", prefix: "CS25", count: 29 }, // total CS = 129
  { code: "CE-22", prefix: "CE22", count: 20 },
  { code: "CE-23", prefix: "CE23", count: 40 },
  { code: "CE-24", prefix: "CE24", count: 40 },
  { code: "CE-25", prefix: "CE25", count: 40 }  // total CE = 140
];

// Batch → Department mapping
const batchToDept = {
  "AI-24": "Artificial Intelligence",
  "AI-25": "Artificial Intelligence",
  "CS-22": "Computer Science",
  "CS-23": "Computer Science",
  "CS-24": "Computer Science",
  "CS-25": "Computer Science",
  "CE-22": "Civil Engineering",
  "CE-23": "Civil Engineering",
  "CE-24": "Civil Engineering",
  "CE-25": "Civil Engineering"
};

async function seedStudents() {
  try {
    console.log("🚀 Connecting to DB...");
    await db.promise().connect();
    console.log("✅ Connected!");

    for (let batch of batches) {
      const deptName = batchToDept[batch.code] || "General";

      // ✅ Department check/create
      const [dept] = await db.promise().query("SELECT id FROM departments WHERE name = ?", [deptName]);
      let deptId;
      if (dept.length === 0) {
        const [dins] = await db.promise().query("INSERT INTO departments (name) VALUES (?)", [deptName]);
        deptId = dins.insertId;
        console.log(`🆕 Department created: ${deptName}`);
      } else {
        deptId = dept[0].id;
      }

      // ✅ Semester check/create
      const [sem] = await db.promise().query("SELECT id FROM semesters WHERE code = ?", [batch.code]);
      let semesterId;
      if (sem.length === 0) {
        const title = `${batch.code} Semester`;
        const exam_date = null;
        const [sins] = await db.promise().query(
          "INSERT INTO semesters (department_id, title, code, exam_date) VALUES (?, ?, ?, ?)",
          [deptId, title, batch.code, exam_date]
        );
        semesterId = sins.insertId;
        console.log(`🆕 Semester created: ${batch.code}`);
      } else {
        semesterId = sem[0].id;
      }

      // ✅ Insert students
      for (let i = 1; i <= batch.count; i++) {
        const roll = `${batch.prefix}-${String(i).padStart(3, "0")}`;
        const name = `Student ${i} (${batch.code})`;

        try {
          await db.promise().query(
            "INSERT INTO students (semester_id, roll_no, full_name) VALUES (?, ?, ?)",
            [semesterId, roll, name]
          );
        } catch (e) {
          console.log(`⚠️ Duplicate skipped: ${roll}`);
        }
      }

      console.log(`✅ Inserted ${batch.count} students for ${batch.code}`);
    }

    console.log("🎉 All students inserted successfully!");
  } catch (err) {
    console.error("❌ Error seeding students:", err);
  } finally {
    db.end();
  }
}

seedStudents();
