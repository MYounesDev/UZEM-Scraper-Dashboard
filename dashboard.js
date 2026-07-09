const { JSDOM } = require('jsdom');
const { DOMParser } = new JSDOM('').window;
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');
const initSqlJs = require('sql.js');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// ==================== CONFIG ====================
const url = 'http://edestek.kocaeli.edu.tr/index.php';
const CONCURRENCY = 100;
const DELAY_MS = 150;
const MAX_RETRIES = 2;

// ==================== STATE ====================
let isRunning = false;
let isPaused = false;
let shouldStop = false;
let pending = 0;
let finished = false;
let requestCount = 0;
let successCount = 0;
let errorCount = 0;
let validStudents = [];
let ogrnos = [];

const engStats = {
    courses: new Map(),
    byYear: new Map(),
    instructors: new Map(),
    instructorCourseKeys: new Map(), // instructor -> Set(courseKey)
};

const fenStats = {
    courses: new Map(),
    byYear: new Map(),
    instructors: new Map(),
    instructorCourseKeys: new Map(), // instructor -> Set(courseKey)
};

// Drill-down indexes
const courseStudents = new Map();     // courseKey -> [{ ogrno, name, faculty, year }]
const instructorCourses = new Map();  // instructor -> [{ courseKey, name, code, faculty }]
const studentIndex = new Map();       // ogrno -> student object

// ==================== HELPERS ====================
function log(msg) {
    console.log(msg);
    io.emit('log', { time: new Date().toISOString(), message: msg });
}

function emitStats() {
    io.emit('stats', {
        isRunning,
        isPaused,
        requestCount,
        successCount,
        errorCount,
        validStudentsCount: validStudents.length,
        pending,
        remaining: ogrnos.length,
        engStats: serializeStats(engStats),
        fenStats: serializeStats(fenStats),
    });
}

function serializeStats(stats) {
    const sortedCourses = Array.from(stats.courses.entries())
        .sort((a, b) => b[1] - a[1]);
    const sortedInstructors = Array.from(stats.instructorCourseKeys.entries())
        .map(([instructor, set]) => [instructor, set.size])
        .sort((a, b) => b[1] - a[1]);
    const byYear = {};
    stats.byYear.forEach((yearMap, year) => {
        const top = Array.from(yearMap.entries()).sort((a, b) => b[1] - a[1])[0];
        if (top) byYear[year] = { course: top[0], count: top[1] };
    });
    return { courses: sortedCourses, instructors: sortedInstructors, byYear };
}

function resetState() {
    isRunning = false;
    isPaused = false;
    shouldStop = false;
    pending = 0;
    finished = false;
    requestCount = 0;
    successCount = 0;
    errorCount = 0;
    validStudents = [];
    engStats.courses.clear();
    engStats.byYear.clear();
    engStats.instructors.clear();
    engStats.instructorCourseKeys.clear();
    fenStats.courses.clear();
    fenStats.byYear.clear();
    fenStats.instructors.clear();
    fenStats.instructorCourseKeys.clear();
    courseStudents.clear();
    instructorCourses.clear();
    studentIndex.clear();
}

function buildOgrnos() {
    const list = [];
    for (let y = 18; y <= 25; y++) {
        for (let g = 1; g <= 2; g++) {
            if (y >= 26 && g === 2) break;
            for (let n = 1; n <= 180; n++) {
                list.push(`${y}020${g}${String(n).padStart(3, '0')}`);
            }
        }
    }
    return list;
}

// ==================== HTML PARSER ====================
function parseResponse(ogrno, html) {
    if (html.includes('Böyle bir kullanıcı Uzem Edestek sistemlerinde mevcut değil')) {
        return null;
    }

    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    const studentNameEl = doc.querySelector('a[title*="Sisteme giriş yapmak"]');
    if (!studentNameEl) return null;

    const fullText = studentNameEl.textContent.trim();
    const parts = fullText.split(' - ').map(s => s.trim());
    if (parts.length < 2) return null;
    const [studentNo, studentName] = parts;

    const year = parseInt(ogrno.substring(0, 2));
    const group = parseInt(ogrno.substring(5, 6));

    const blocks = doc.querySelectorAll('.w3-center');
    const studentFaculties = new Set();
    const courses = [];

    for (const block of blocks) {
        const blueHeader = block.querySelector('.w3-blue strong');
        if (!blueHeader) continue;

        const headerText = blueHeader.textContent.trim();
        let blockFaculty = null;

        if (headerText.includes('MÜHENDİSLİK FAKÜLTESİ')) {
            blockFaculty = 'MUHENDISLIK';
        } else if (headerText.includes('FAKÜLTELER (FEN)')) {
            blockFaculty = 'FEN_UZEM';
        } else continue;

        studentFaculties.add(blockFaculty);

        const courseLinks = block.querySelectorAll('a.w3-button');
        courseLinks.forEach(link => {
            const name = link.textContent.trim();
            const code = link.getAttribute('title') || '';
            const instructorMatch = name.match(/\(([^)]+)\)$/);
            const instructor = instructorMatch ? instructorMatch[1].trim() : 'Bilinmiyor';
            const courseKey = `${name} (${code})`.trim();

            const cleanName = name.split('(')[0].trim();
            const courseObj = { name: cleanName, code, instructor, courseKey, faculty: blockFaculty };
            courses.push(courseObj);

            const stats = blockFaculty === 'MUHENDISLIK' ? engStats : fenStats;
            stats.courses.set(courseKey, (stats.courses.get(courseKey) || 0) + 1);

            if (!stats.byYear.has(year)) stats.byYear.set(year, new Map());
            const yearMap = stats.byYear.get(year);
            yearMap.set(courseKey, (yearMap.get(courseKey) || 0) + 1);

            stats.instructors.set(instructor, (stats.instructors.get(instructor) || 0) + 1);

            if (!stats.instructorCourseKeys.has(instructor)) {
                stats.instructorCourseKeys.set(instructor, new Set());
            }
            stats.instructorCourseKeys.get(instructor).add(courseKey);

            // Drill-down indexes
            if (!courseStudents.has(courseKey)) courseStudents.set(courseKey, []);
            courseStudents.get(courseKey).push({ ogrno, name: studentName, faculty: blockFaculty, year });

            if (!instructorCourses.has(instructor)) instructorCourses.set(instructor, []);
            instructorCourses.get(instructor).push(courseObj);
        });
    }

    if (studentFaculties.size > 0 && courses.length > 0) {
        const faculties = Array.from(studentFaculties);
        const student = { ogrno, name: studentName, year, group, faculties, courses };
        validStudents.push(student);
        studentIndex.set(ogrno, student);
        io.emit('studentFound', student);
        return faculties.join('+');
    }
    return null;
}

// ==================== FETCH WITH RETRY ====================
async function fetchStudent(ogrno, attempt = 1) {
    requestCount++;
    const currentReqNum = requestCount;
    io.emit('requestSent', { reqNum: currentReqNum, ogrno, attempt });

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'content-type': 'application/x-www-form-urlencoded',
                'cache-control': 'no-cache',
            },
            body: `ogrno=${ogrno}`,
            credentials: 'omit',
        });

        io.emit('responseReceived', { reqNum: currentReqNum, ogrno, status: res.status, statusText: res.statusText });

        if (!res.ok) {
            throw new Error(`HTTP ${res.status} ${res.statusText}`);
        }

        const html = await res.text();
        const faculty = parseResponse(ogrno, html);
        if (faculty) {
            successCount++;
            log(`✅ ${ogrno} (${faculty})`);
        }
        return true;
    } catch (err) {
        errorCount++;
        io.emit('responseReceived', { reqNum: currentReqNum, ogrno, status: 'ERR', statusText: err.message });
        log(`❌ ${ogrno} ERROR (attempt ${attempt}): ${err.message}`);

        if (attempt < MAX_RETRIES) {
            await new Promise(r => setTimeout(r, 500));
            return fetchStudent(ogrno, attempt + 1);
        }
        return false;
    }
}

// ==================== MAIN LOOP ====================
function processNext() {
    if (shouldStop || ogrnos.length === 0) {
        if (pending === 0 && !finished) {
            finished = true;
            isRunning = false;
            isPaused = false;
            log('🏁 Tarama tamamlandı.');
            emitStats();
            io.emit('completed');
        }
        return;
    }

    if (isPaused) return;

    const ogrno = ogrnos.shift();
    pending++;
    emitStats();

    fetchStudent(ogrno)
        .finally(() => {
            pending--;
            emitStats();
            if (!shouldStop && !isPaused) {
                setTimeout(() => processNext(), DELAY_MS);
            } else if (pending === 0 && (shouldStop || ogrnos.length === 0)) {
                finished = true;
                isRunning = false;
                isPaused = false;
                log(shouldStop ? '🛑 Tarama durduruldu.' : '🏁 Tarama tamamlandı.');
                emitStats();
                io.emit('completed');
            }
        });
}

function startFetching() {
    if (isRunning) return;
    resetState();
    ogrnos = buildOgrnos();
    isRunning = true;
    isPaused = false;
    shouldStop = false;
    finished = false;
    log(`🚀 ${ogrnos.length} öğrenci numarası taranıyor...`);
    emitStats();
    for (let i = 0; i < CONCURRENCY; i++) processNext();
}


function pauseFetching() {
    if (!isRunning || isPaused) return;
    isPaused = true;
    log('⏸️ Tarama duraklatıldı.');
    emitStats();
}

function resumeFetching() {
    if (!isRunning || !isPaused) return;
    isPaused = false;
    log('▶️ Tarama devam ediyor.');
    emitStats();
    const workers = Math.max(0, CONCURRENCY - pending);
    for (let i = 0; i < workers; i++) processNext();
}

function stopFetching() {
    if (!isRunning) return;
    shouldStop = true;
    log('🛑 STOP COMMAND RECEIVED');
    emitStats();
}

// ==================== QUERY HELPERS ====================
function getStudentsByCourse(courseKey, faculty) {
    return validStudents
        .filter(s => s.courses.some(c => c.courseKey === courseKey && (faculty === 'all' || c.faculty === faculty)))
        .map(s => ({
            ogrno: s.ogrno,
            name: s.name,
            year: s.year,
            group: s.group,
            faculties: s.faculties,
        }));
}

function getCoursesByInstructor(instructorName) {
    const courseMap = new Map();
    validStudents.forEach(s => {
        s.courses.forEach(c => {
            if (c.instructor === instructorName) {
                courseMap.set(c.courseKey, {
                    courseKey: c.courseKey,
                    name: c.name,
                    code: c.code,
                    instructor: c.instructor,
                });
            }
        });
    });
    return Array.from(courseMap.values());
}

function getStudentDetails(ogrno) {
    const student = validStudents.find(s => s.ogrno === ogrno);
    if (!student) return null;
    const engCourses = student.courses.filter(c => c.faculty === 'MUHENDISLIK');
    const fenCourses = student.courses.filter(c => c.faculty === 'FEN_UZEM');
    return {
        ...student,
        coursesByFaculty: {
            MUHENDISLIK: engCourses,
            FEN_UZEM: fenCourses,
        }
    };
}

// ==================== SOCKET.IO ====================
io.on('connection', (socket) => {
    log(`🔌 Client connected: ${socket.id}`);
    emitStats();
    socket.emit('studentsSnapshot', validStudents);

    socket.on('start', () => startFetching());
    socket.on('pause', () => pauseFetching());
    socket.on('resume', () => resumeFetching());
    socket.on('stop', () => stopFetching());

    socket.on('queryStudentsByCourse', ({ courseKey, faculty }, callback) => {
        const students = getStudentsByCourse(courseKey, faculty);
        callback({ courseKey, faculty, students });
    });

    socket.on('queryCoursesByInstructor', ({ instructor }, callback) => {
        const courses = getCoursesByInstructor(instructor);
        callback({ instructor, courses });
    });

    socket.on('queryStudentDetails', ({ ogrno }, callback) => {
        const student = getStudentDetails(ogrno);
        callback({ student });
    });

    socket.on('disconnect', () => {
        log(`🔌 Client disconnected: ${socket.id}`);
    });
});

// ==================== SQLITE EXPORT ====================
async function generateSQLiteDb() {
    const SQL = await initSqlJs();
    const db = new SQL.Database();

    db.run(`
        CREATE TABLE faculties (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL
        );
    `);

    db.run(`
        CREATE TABLE instructors (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE
        );
    `);

    db.run(`
        CREATE TABLE students (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ogrno TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            year INTEGER,
            group_id INTEGER
        );
    `);

    db.run(`
        CREATE TABLE courses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            course_key TEXT NOT NULL,
            name TEXT NOT NULL,
            code TEXT NOT NULL,
            faculty_id INTEGER NOT NULL,
            instructor_id INTEGER NOT NULL,
            UNIQUE(course_key, faculty_id),
            FOREIGN KEY (faculty_id) REFERENCES faculties(id),
            FOREIGN KEY (instructor_id) REFERENCES instructors(id)
        );
    `);

    db.run(`
        CREATE TABLE student_faculties (
            student_id INTEGER NOT NULL,
            faculty_id INTEGER NOT NULL,
            PRIMARY KEY (student_id, faculty_id),
            FOREIGN KEY (student_id) REFERENCES students(id),
            FOREIGN KEY (faculty_id) REFERENCES faculties(id)
        );
    `);

    db.run(`
        CREATE TABLE student_courses (
            student_id INTEGER NOT NULL,
            course_id INTEGER NOT NULL,
            PRIMARY KEY (student_id, course_id),
            FOREIGN KEY (student_id) REFERENCES students(id),
            FOREIGN KEY (course_id) REFERENCES courses(id)
        );
    `);

    const faculties = [
        { code: 'MUHENDISLIK', name: 'Mühendislik Fakültesi' },
        { code: 'FEN_UZEM', name: 'Fakülteler (FEN) / UZEM' },
    ];
    const facultyIdMap = new Map();
    const facultyStmt = db.prepare('INSERT INTO faculties (code, name) VALUES (?, ?)');
    faculties.forEach((f, i) => {
        facultyStmt.run([f.code, f.name]);
        facultyIdMap.set(f.code, i + 1);
    });
    facultyStmt.free();

    const instructorSet = new Set();
    validStudents.forEach(s => s.courses.forEach(c => instructorSet.add(c.instructor)));
    const instructors = Array.from(instructorSet).sort();
    const instructorIdMap = new Map();
    const instructorStmt = db.prepare('INSERT INTO instructors (name) VALUES (?)');
    instructors.forEach((name, i) => {
        instructorStmt.run([name]);
        instructorIdMap.set(name, i + 1);
    });
    instructorStmt.free();

    const studentIdMap = new Map();
    const studentStmt = db.prepare('INSERT INTO students (ogrno, name, year, group_id) VALUES (?, ?, ?, ?)');
    validStudents.forEach((s, i) => {
        studentStmt.run([s.ogrno, s.name, s.year, s.group]);
        studentIdMap.set(s.ogrno, i + 1);
    });
    studentStmt.free();

    const courseMap = new Map();
    validStudents.forEach(s => {
        s.courses.forEach(c => {
            const key = `${c.courseKey}|${c.faculty}`;
            if (!courseMap.has(key)) courseMap.set(key, c);
        });
    });
    const courses = Array.from(courseMap.values());
    const courseIdMap = new Map();
    const courseStmt = db.prepare('INSERT INTO courses (course_key, name, code, faculty_id, instructor_id) VALUES (?, ?, ?, ?, ?)');
    courses.forEach((c, i) => {
        const key = `${c.courseKey}|${c.faculty}`;
        courseStmt.run([c.courseKey, c.name, c.code, facultyIdMap.get(c.faculty), instructorIdMap.get(c.instructor)]);
        courseIdMap.set(key, i + 1);
    });
    courseStmt.free();

    const sfStmt = db.prepare('INSERT INTO student_faculties (student_id, faculty_id) VALUES (?, ?)');
    validStudents.forEach(s => {
        const studentId = studentIdMap.get(s.ogrno);
        s.faculties.forEach(facultyCode => {
            sfStmt.run([studentId, facultyIdMap.get(facultyCode)]);
        });
    });
    sfStmt.free();

    const scStmt = db.prepare('INSERT INTO student_courses (student_id, course_id) VALUES (?, ?)');
    validStudents.forEach(s => {
        const studentId = studentIdMap.get(s.ogrno);
        s.courses.forEach(c => {
            const key = `${c.courseKey}|${c.faculty}`;
            scStmt.run([studentId, courseIdMap.get(key)]);
        });
    });
    scStmt.free();

    const data = db.export();
    db.close();
    return Buffer.from(data);
}

// ==================== HTTP ROUTES ====================
app.get('/api/students', (req, res) => {
    res.json(validStudents);
});

app.get('/api/stats', (req, res) => {
    res.json({
        isRunning,
        isPaused,
        requestCount,
        successCount,
        errorCount,
        validStudentsCount: validStudents.length,
        pending,
        remaining: ogrnos.length,
        engStats: serializeStats(engStats),
        fenStats: serializeStats(fenStats),
    });
});

app.get('/api/export/db', async (req, res) => {
    const buffer = await generateSQLiteDb();
    const filename = `ogrenci_veri_export_${new Date().toISOString().replace(/[:.]/g, '-')}.db`;
    res.setHeader('Content-Type', 'application/vnd.sqlite3');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==================== START SERVER ====================
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
    console.log(`🌐 Dashboard running at http://localhost:${PORT}`);
});
