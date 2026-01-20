// Global state
let teachers = [];
let subjects = [];
let classrooms = [];
let semesters = [];
let currentSessionId = null;
let currentTimetable = [];
let currentMetadata = {};
let editingIndex = null;
let addTarget = null; // when set, save acts as add-entry for the clicked empty cell

// In-memory storage to replace backend
const timetablesStore = {};
const sessionMemoryStore = {};

function sortTimeSlots(slots) {
    /** Sort time slots chronologically using 12h-to-24h conversion with AM/PM awareness */
    const getSortKey = (slotStr) => {
        try {
            let startPart = slotStr;
            const seps = ['–', '—', '-'];
            for (const sep of seps) {
                if (slotStr.includes(sep)) {
                    startPart = slotStr.split(sep)[0].trim();
                    break;
                }
            }

            const timeUpper = startPart.toUpperCase();
            const isPM = timeUpper.includes('PM') || timeUpper.includes('P.M.');
            const isAM = timeUpper.includes('AM') || timeUpper.includes('A.M.');

            let timePart = startPart.split(' ')[0];
            let h, m;
            if (timePart.includes(':')) {
                [h, m] = timePart.split(':').map(Number);
            } else {
                h = Number(timePart);
                m = 0;
            }

            if (isPM) {
                if (h !== 12) h += 12;
            } else if (isAM) {
                if (h === 12) h = 0;
            } else if (h >= 1 && h < 7) {
                h += 12;
            }

            return h * 60 + m;
        } catch (e) {
            return 0;
        }
    };

    return [...new Set(slots)].sort((a, b) => getSortKey(a) - getSortKey(b));
}

class TimetableGenerator {
    constructor(teachers, subjects, classrooms, time_slots, days, semesters) {
        this.teachers = teachers;
        this.subjects = subjects;
        this.classrooms = classrooms;
        this.time_slots = time_slots;
        this.days = days;
        this.semesters = semesters;
        this.timetable = [];
        this.conflicts = [];
    }

    _subjectColor(name) {
        let h = 0;
        for (let i = 0; i < name.length; i++) {
            h = (h * 31 + name.charCodeAt(i)) % 360;
        }
        return `hsl(${h},65%,85%)`;
    }

    _rankSlots(cohortLoad, day, slot, cohort) {
        const dayLoad = (cohortLoad[cohort] && cohortLoad[cohort][day]) || 0;
        return dayLoad * 10;
    }

    isTeacherAvailable(teacher, day, slot) {
        const availability = teacher.availability || {};
        if (Object.keys(availability).length === 0) return true;
        const daySlots = availability[day] || [];
        return daySlots.includes(slot);
    }

    generate() {
        this.timetable = [];
        this.conflicts = [];

        const subjectToTeachers = {};
        this.teachers.forEach(t => {
            (t.subjects || []).forEach(s => {
                const key = (s || '').trim().toLowerCase();
                if (!key) return;
                if (!subjectToTeachers[key]) subjectToTeachers[key] = [];
                subjectToTeachers[key].push(t);
            });
        });

        const daysOrder = [...this.days];
        const slotsOrder = [...this.time_slots];

        const teacherSchedule = {};
        this.teachers.forEach(t => {
            teacherSchedule[t.name] = {};
            daysOrder.forEach(d => {
                teacherSchedule[t.name][d] = {};
                slotsOrder.forEach(s => {
                    teacherSchedule[t.name][d][s] = false;
                });
            });
        });

        const classroomSchedule = {};
        this.classrooms.forEach(c => {
            classroomSchedule[c] = {};
            daysOrder.forEach(d => {
                classroomSchedule[c][d] = {};
                slotsOrder.forEach(s => {
                    classroomSchedule[c][d][s] = false;
                });
            });
        });

        const distinctSemesters = new Set(this.subjects.map(s => s.semester || 'General'));
        if (distinctSemesters.size === 0) distinctSemesters.add('General');
        
        const cohortSchedule = {};
        distinctSemesters.forEach(sem => {
            cohortSchedule[sem] = {};
            daysOrder.forEach(d => {
                cohortSchedule[sem][d] = {};
                slotsOrder.forEach(s => {
                    cohortSchedule[sem][d][s] = null;
                });
            });
        });

        const cohortLoad = {};

        const canPlace = (subject, teacher, classroom, day, slot) => {
            let isBreak = false;
            const seps = ['–', '—', '-'];
            for (const sep of seps) {
                if (slot.includes(sep)) {
                    const parts = slot.split(sep);
                    if (parts.length >= 2 && parts[0].trim() === "11:30" && parts[1].trim().startsWith("01:00")) {
                        isBreak = true;
                        break;
                    }
                }
            }
            if (isBreak) return false;

            const semester = subject.semester || 'General';
            if (teacherSchedule[teacher.name][day][slot]) return false;
            if (classroomSchedule[classroom][day][slot]) return false;

            const existingSubject = cohortSchedule[semester][day][slot];
            if (existingSubject !== null && existingSubject !== subject.name) return false;

            if (!this.isTeacherAvailable(teacher, day, slot)) return false;

            return true;
        };

        const extractAllDeptCodes = (subject) => {
            try {
                const depts = subject.departments || [];
                if (!Array.isArray(depts) || depts.length === 0) return [];
                const codes = [];
                depts.forEach(d => {
                    const raw = String(d).trim();
                    if (!raw) return;
                    let code = null;
                    const seps = ['–', '—', '-'];
                    for (const sep of seps) {
                        if (raw.includes(sep)) {
                            const token = raw.split(sep)[0].trim();
                            code = token || raw.split(sep)[0].trim();
                            break;
                        }
                    }
                    if (code === null) code = raw.split(' ')[0];
                    if (code) codes.push(code);
                });
                return [...new Set(codes)];
            } catch (e) {
                return [];
            }
        };

        const placeEntry = (subject, teacher, classroom, day, slot) => {
            const semester = subject.semester || 'General';
            const entry = {
                day: day,
                time_slot: slot,
                subject: subject.name,
                teacher: teacher.name,
                semester: semester,
                classrooms: [classroom],
                department_codes: extractAllDeptCodes(subject)
            };
            this.timetable.push(entry);
            teacherSchedule[teacher.name][day][slot] = true;
            classroomSchedule[classroom][day][slot] = true;

            if (cohortSchedule[semester][day][slot] === null) {
                cohortSchedule[semester][day][slot] = subject.name;
                if (!cohortLoad[semester]) cohortLoad[semester] = {};
                cohortLoad[semester][day] = (cohortLoad[semester][day] || 0) + 1;
            }
        };

        const rankSlotsForSemester = (semester) => {
            const ranked = [];
            daysOrder.forEach(day => {
                const load = (cohortLoad[semester] && cohortLoad[semester][day]) || 0;
                slotsOrder.forEach(slot => {
                    const score = this._rankSlots(cohortLoad, day, slot, semester);
                    ranked.push({ score: score + load * 10, day, slot });
                });
            });
            ranked.sort((a, b) => {
                if (a.score !== b.score) return a.score - b.score;
                if (daysOrder.indexOf(a.day) !== daysOrder.indexOf(b.day)) 
                    return daysOrder.indexOf(a.day) - daysOrder.indexOf(b.day);
                return slotsOrder.indexOf(a.slot) - slotsOrder.indexOf(b.slot);
            });
            return ranked.map(r => ({ day: r.day, slot: r.slot }));
        };

        const allCandidateAssignments = (subject) => {
            const semester = subject.semester || 'General';
            const subjectKey = (subject.name || '').trim().toLowerCase();
            let teachersForSubject = subjectToTeachers[subjectKey] || [];

            const assignedTeacherId = subject.teacher_id;
            if (assignedTeacherId) {
                teachersForSubject = teachersForSubject.filter(t => t.name === assignedTeacherId);
            }
            if (teachersForSubject.length === 0) return [];

            const candidates = [];
            const rankedSlots = rankSlotsForSemester(semester);
            
            rankedSlots.forEach(({ day, slot }) => {
                teachersForSubject.forEach(t => {
                    if (!this.isTeacherAvailable(t, day, slot)) return;
                    this.classrooms.forEach(c => {
                        if (canPlace(subject, t, c, day, slot)) {
                            let tLoad = 0;
                            daysOrder.forEach(d => {
                                slotsOrder.forEach(s => {
                                    if (teacherSchedule[t.name][d][s]) tLoad++;
                                });
                            });
                            candidates.push({ tLoad, dIdx: daysOrder.indexOf(day), sIdx: slotsOrder.indexOf(slot), day, slot, t, c });
                        }
                    });
                });
            });

            candidates.sort((a, b) => {
                if (a.tLoad !== b.tLoad) return a.tLoad - b.tLoad;
                if (a.dIdx !== b.dIdx) return a.dIdx - b.dIdx;
                if (a.sIdx !== b.sIdx) return a.sIdx - b.sIdx;
                if (a.t.name.toLowerCase() !== b.t.name.toLowerCase()) 
                    return a.t.name.toLowerCase().localeCompare(b.t.name.toLowerCase());
                return a.c.localeCompare(b.c);
            });

            return candidates.map(c => ({ day: c.day, slot: c.slot, teacher: c.t, classroom: c.c }));
        };

        this.subjects.forEach(subject => {
            const sessionsRequired = parseInt(subject.sessions_per_week || 2) || 0;
            let placed = 0;
            const feasible = allCandidateAssignments(subject);
            const usedPositions = new Set();
            const usedDays = new Set();
            const feasibleDays = new Set(feasible.map(f => f.day));

            for (const { day, slot, teacher, classroom } of feasible) {
                if (placed >= sessionsRequired) break;
                const posKey = `${day}|${slot}`;
                if (usedPositions.has(posKey)) continue;
                if (feasibleDays.size >= sessionsRequired && usedDays.has(day)) continue;

                if (canPlace(subject, teacher, classroom, day, slot)) {
                    placeEntry(subject, teacher, classroom, day, slot);
                    usedPositions.add(posKey);
                    usedDays.add(day);
                    placed++;
                }
            }

            if (placed < sessionsRequired) {
                for (const { day, slot, teacher, classroom } of feasible) {
                    if (placed >= sessionsRequired) break;
                    if (canPlace(subject, teacher, classroom, day, slot)) {
                        placeEntry(subject, teacher, classroom, day, slot);
                        placed++;
                    }
                }
            }

            if (placed < sessionsRequired) {
                const missing = sessionsRequired - placed;
                const reasons = [];
                const subjectKey = (subject.name || '').trim().toLowerCase();
                const teachersForSubject = subjectToTeachers[subjectKey] || [];

                if (teachersForSubject.length === 0) {
                    reasons.push('No teacher associated with subject');
                } else {
                    daysOrder.forEach(day => {
                        slotsOrder.forEach(slot => {
                            const anyTeacherFree = teachersForSubject.some(t => 
                                this.isTeacherAvailable(t, day, slot) && !teacherSchedule[t.name][day][slot]
                            );
                            const anyClassFree = this.classrooms.some(c => !classroomSchedule[c][day][slot]);
                            const semester = subject.semester || 'General';
                            const existingSubject = cohortSchedule[semester][day][slot];
                            const cohortBusy = (existingSubject !== null && existingSubject !== subject.name);

                            if (!anyTeacherFree) reasons.push(`No available teacher at ${day} ${slot}`);
                            if (!anyClassFree) reasons.push(`No available classroom at ${day} ${slot}`);
                            if (cohortBusy) reasons.push(`Semester busy with ${existingSubject} at ${day} ${slot}`);
                        });
                    });
                }

                const suggestions = [];
                outer: for (const day of daysOrder) {
                    for (const slot of slotsOrder) {
                        const semester = subject.semester || 'General';
                        const existingSubject = cohortSchedule[semester][day][slot];
                        if (existingSubject !== null && existingSubject !== subject.name) continue;

                        const freeTeachers = teachersForSubject.filter(t => 
                            this.isTeacherAvailable(t, day, slot) && !teacherSchedule[t.name][day][slot]
                        );
                        const freeClasses = this.classrooms.filter(c => !classroomSchedule[c][day][slot]);

                        if (freeTeachers.length > 0 && freeClasses.length > 0) {
                            suggestions.push(`${day} @ ${slot}`);
                        }
                        if (suggestions.length >= 5) break outer;
                    }
                }

                this.conflicts.push({
                    type: 'student',
                    semester: subject.semester || 'General',
                    time_slot: null,
                    day: null,
                    subjects: [subject.name],
                    missing_sessions: missing,
                    suggestions: suggestions,
                    reasons: [...new Set(reasons)]
                });
            }
        });

        this.detectConflicts();
        return { timetable: this.timetable, conflicts: this.conflicts };
    }

    detectConflicts() {
        const daysOrder = [...this.days];
        const slotsOrder = [...this.time_slots];
        const conflicts = [];

        daysOrder.forEach(day => {
            slotsOrder.forEach(slot => {
                const teacherMap = {};
                const classroomMap = {};
                const cohortMap = {};

                const entries = this.timetable.filter(e => e.day === day && e.time_slot === slot);
                entries.forEach(e => {
                    if (!teacherMap[e.teacher]) teacherMap[e.teacher] = [];
                    teacherMap[e.teacher].push(e);

                    (e.classrooms || []).forEach(c => {
                        if (!classroomMap[c]) classroomMap[c] = [];
                        classroomMap[c].push(e);
                    });

                    const sem = e.semester || 'General';
                    if (!cohortMap[sem]) cohortMap[sem] = [];
                    cohortMap[sem].push(e);
                });

                Object.entries(teacherMap).forEach(([t, arr]) => {
                    if (arr.length > 1) {
                        conflicts.push({
                            type: 'teacher', teacher: t, day: day, time_slot: slot,
                            subjects: arr.map(x => x.subject)
                        });
                    }
                });

                Object.entries(classroomMap).forEach(([c, arr]) => {
                    if (arr.length > 1) {
                        conflicts.push({
                            type: 'classroom', classroom: c, day: day, time_slot: slot,
                            subjects: arr.map(x => x.subject)
                        });
                    }
                });

                Object.entries(cohortMap).forEach(([cohort, arr]) => {
                    const uniqueSubjects = new Set(arr.map(x => x.subject));
                    if (uniqueSubjects.size > 1) {
                        conflicts.push({
                            type: 'student', semester: cohort, day: day, time_slot: slot,
                            subjects: Array.from(uniqueSubjects)
                        });
                    }
                });
            });
        });

        this.conflicts.push(...conflicts);
    }
}

// Color map for subjects in UI (fallback if backend doesn't provide colors)
const subjectColors = {};
function colorForSubject(name){
    if(subjectColors[name]) return subjectColors[name];
    // deterministic pastel color from hash
    let hash = 0; for(let i=0;i<name.length;i++){ hash = ((hash<<5)-hash)+name.charCodeAt(i); hash|=0; }
    const hue = Math.abs(hash)%360; const sat=65; const light=85;
    const color = `hsl(${hue} ${sat}% ${light}%)`;
    subjectColors[name]=color; return color;
}

// Theme presets
const themePresets = {
    default: {
        header: '#4a90e2',
        body: '#f5f7fa',
        card: '#ffffff',
        accent: '#4a90e2'
    },
    purple: {
        header: '#667eea',
        body: '#f3f4ff',
        card: '#ffffff',
        accent: '#667eea'
    },
    green: {
        header: '#56ab2f',
        body: '#f0f8f0',
        card: '#ffffff',
        accent: '#56ab2f'
    },
    orange: {
        header: '#f46b45',
        body: '#fff5f0',
        card: '#ffffff',
        accent: '#f46b45'
    },
    red: {
        header: '#eb3349',
        body: '#fff0f0',
        card: '#ffffff',
        accent: '#eb3349'
    },
    dark: {
        header: '#2c3e50',
        body: '#34495e',
        card: '#2c3e50',
        accent: '#3498db'
    }
};

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', function() {
    console.log('🚀 Application starting...');
    initializeApp();
    initializeTheme();
});

function initializeApp() {
    console.log('📝 Initializing application...');
    setupNavigation();
    setupButtons();
    setupSemesters(3);
    renderAll();
    console.log('✅ Application initialized successfully');
}

// Theme initialization
function initializeTheme() {
    console.log('🎨 Initializing theme customization...');
    
    // Load saved theme from localStorage
    loadThemeFromStorage();
    
    // Theme toggle button
    document.getElementById('theme-toggle-btn')?.addEventListener('click', function() {
        toggleThemePanel();
    });
    
    // Close theme panel
    document.getElementById('close-theme-btn')?.addEventListener('click', function() {
        closeThemePanel();
    });
    
    // Color pickers
    document.getElementById('header-color')?.addEventListener('input', function() {
        document.getElementById('header-color-text').value = this.value;
    });
    
    document.getElementById('body-color')?.addEventListener('input', function() {
        document.getElementById('body-color-text').value = this.value;
    });
    
    document.getElementById('card-color')?.addEventListener('input', function() {
        document.getElementById('card-color-text').value = this.value;
    });
    
    document.getElementById('accent-color')?.addEventListener('input', function() {
        document.getElementById('accent-color-text').value = this.value;
    });
    
    // Apply theme button
    document.getElementById('apply-theme-btn')?.addEventListener('click', function() {
        applyTheme();
    });
    
    // Reset theme button
    document.getElementById('reset-theme-btn')?.addEventListener('click', function() {
        resetTheme();
    });
    
    // Preset buttons
    document.querySelectorAll('.preset-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            const preset = this.dataset.preset;
            applyPreset(preset);
        });
    });
    
    console.log('✅ Theme customization initialized');
}

// Toggle theme panel
function toggleThemePanel() {
    const panel = document.getElementById('theme-panel');
    
    // Create overlay if it doesn't exist
    let overlay = document.getElementById('theme-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'theme-overlay';
        overlay.className = 'theme-overlay';
        overlay.addEventListener('click', closeThemePanel);
        document.body.appendChild(overlay);
    }
    
    panel.classList.toggle('active');
    overlay.classList.toggle('active');
}

// Close theme panel
function closeThemePanel() {
    const panel = document.getElementById('theme-panel');
    const overlay = document.getElementById('theme-overlay');
    
    panel.classList.remove('active');
    if (overlay) {
        overlay.classList.remove('active');
    }
}

// Utility: Get contrast color (dark or light) for text
function getContrastColor(hexcolor) {
    // If a leading # is provided, remove it
    if (hexcolor.slice(0, 1) === '#') {
        hexcolor = hexcolor.slice(1);
    }
    // Convert to RGB value
    var r = parseInt(hexcolor.substr(0,2),16);
    var g = parseInt(hexcolor.substr(2,2),16);
    var b = parseInt(hexcolor.substr(4,2),16);
    // Get YIQ ratio
    var yiq = ((r * 299) + (g * 587) + (b * 114)) / 1000;
    // Check contrast
    return (yiq >= 128) ? '#333333' : '#ecf0f1';
}

// Apply theme
function applyTheme() {
    const headerColor = document.getElementById('header-color').value;
    const bodyColor = document.getElementById('body-color').value;
    const cardColor = document.getElementById('card-color').value;
    const accentColor = document.getElementById('accent-color').value;
    
    // Calculate secondary color (darker version of header)
    const secondaryColor = shadeColor(headerColor, -20);
    
    // Determine if theme is dark based on card color
    const isDark = getContrastColor(cardColor) === '#ecf0f1';
    
    const textColor = isDark ? '#ecf0f1' : '#333333';
    const textLightColor = isDark ? '#bdc3c7' : '#6c757d';
    const borderColor = isDark ? '#4a5568' : '#dde1e6';
    const headingColor = isDark ? '#ffffff' : '#2c3e50';
    const inputBg = isDark ? '#1a202c' : '#ffffff';
    const lightColor = isDark ? '#34495e' : '#ecf0f1';
    const hoverBg = isDark ? 'rgba(255,255,255,0.05)' : '#ecf0f1';

    // Calculate hover states for buttons
    const primaryHover = shadeColor(accentColor, -15);
    const secondaryHover = shadeColor(textLightColor, -15);
    const successHover = shadeColor('#5cb85c', -15);
    const dangerHover = shadeColor('#d9534f', -15);

    // Apply CSS variables
    document.documentElement.style.setProperty('--primary-color', accentColor);
    document.documentElement.style.setProperty('--primary-hover', primaryHover);
    document.documentElement.style.setProperty('--secondary-color', secondaryColor);
    document.documentElement.style.setProperty('--secondary-hover', secondaryHover);
    document.documentElement.style.setProperty('--success-hover', successHover);
    document.documentElement.style.setProperty('--danger-hover', dangerHover);
    document.documentElement.style.setProperty('--bg-color', bodyColor);
    document.documentElement.style.setProperty('--card-bg', cardColor);
    
    document.documentElement.style.setProperty('--text-color', textColor);
    document.documentElement.style.setProperty('--text-light', textLightColor);
    document.documentElement.style.setProperty('--border-color', borderColor);
    document.documentElement.style.setProperty('--heading-color', headingColor);
    document.documentElement.style.setProperty('--input-bg', inputBg);
    document.documentElement.style.setProperty('--light-color', lightColor);
    document.documentElement.style.setProperty('--hover-bg', hoverBg);
    
    // Update header gradient
    const header = document.querySelector('.header');
    if (header) {
        header.style.background = `linear-gradient(135deg, ${headerColor}, ${secondaryColor})`;
    }
    
    // Save to localStorage
    const theme = {
        header: headerColor,
        body: bodyColor,
        card: cardColor,
        accent: accentColor
    };
    localStorage.setItem('timetable-theme', JSON.stringify(theme));
    
    showNotification('🎨 Theme applied successfully!', 'success');
    closeThemePanel();
}

// Apply preset theme
function applyPreset(presetName) {
    const preset = themePresets[presetName];
    if (!preset) return;
    
    document.getElementById('header-color').value = preset.header;
    document.getElementById('header-color-text').value = preset.header;
    document.getElementById('body-color').value = preset.body;
    document.getElementById('body-color-text').value = preset.body;
    document.getElementById('card-color').value = preset.card;
    document.getElementById('card-color-text').value = preset.card;
    document.getElementById('accent-color').value = preset.accent;
    document.getElementById('accent-color-text').value = preset.accent;
    
    showNotification(`🎨 ${presetName.charAt(0).toUpperCase() + presetName.slice(1)} preset loaded!`, 'success');
}

// Reset to default theme
function resetTheme() {
    applyPreset('default');
    applyTheme();
    showNotification('🎨 Theme reset to default', 'success');
}

// Load theme from localStorage
function loadThemeFromStorage() {
    const savedTheme = localStorage.getItem('timetable-theme');
    if (savedTheme) {
        try {
            const theme = JSON.parse(savedTheme);
            
            // Set color pickers
            document.getElementById('header-color').value = theme.header;
            document.getElementById('header-color-text').value = theme.header;
            document.getElementById('body-color').value = theme.body;
            document.getElementById('body-color-text').value = theme.body;
            document.getElementById('card-color').value = theme.card;
            document.getElementById('card-color-text').value = theme.card;
            document.getElementById('accent-color').value = theme.accent;
            document.getElementById('accent-color-text').value = theme.accent;
            
            // Apply theme
            const secondaryColor = shadeColor(theme.header, -20);
            
            // Determine if theme is dark based on card color
            const isDark = getContrastColor(theme.card) === '#ecf0f1';
            
            const textColor = isDark ? '#ecf0f1' : '#333333';
            const textLightColor = isDark ? '#bdc3c7' : '#6c757d';
            const borderColor = isDark ? '#4a5568' : '#dde1e6';
            const headingColor = isDark ? '#ffffff' : '#2c3e50';
            const inputBg = isDark ? '#1a202c' : '#ffffff';
            const lightColor = isDark ? '#34495e' : '#ecf0f1';
            const hoverBg = isDark ? 'rgba(255,255,255,0.05)' : '#ecf0f1';

            // Calculate hover states
            const primaryHover = shadeColor(theme.accent, -15);
            const secondaryHover = shadeColor(textLightColor, -15);
            const successHover = shadeColor('#5cb85c', -15);
            const dangerHover = shadeColor('#d9534f', -15);

            document.documentElement.style.setProperty('--primary-color', theme.accent);
            document.documentElement.style.setProperty('--primary-hover', primaryHover);
            document.documentElement.style.setProperty('--secondary-color', secondaryColor);
            document.documentElement.style.setProperty('--secondary-hover', secondaryHover);
            document.documentElement.style.setProperty('--success-hover', successHover);
            document.documentElement.style.setProperty('--danger-hover', dangerHover);
            document.documentElement.style.setProperty('--bg-color', theme.body);
            document.documentElement.style.setProperty('--card-bg', theme.card);
            
            document.documentElement.style.setProperty('--text-color', textColor);
            document.documentElement.style.setProperty('--text-light', textLightColor);
            document.documentElement.style.setProperty('--border-color', borderColor);
            document.documentElement.style.setProperty('--heading-color', headingColor);
            document.documentElement.style.setProperty('--input-bg', inputBg);
            document.documentElement.style.setProperty('--light-color', lightColor);
            document.documentElement.style.setProperty('--hover-bg', hoverBg);
            
            const header = document.querySelector('.header');
            if (header) {
                header.style.background = `linear-gradient(135deg, ${theme.header}, ${secondaryColor})`;
            }
            
            console.log('🎨 Theme loaded from storage');
        } catch (e) {
            console.error('Failed to load theme:', e);
        }
    }
}

// Utility: Darken or lighten a color
function shadeColor(color, percent) {
    let R = parseInt(color.substring(1, 3), 16);
    let G = parseInt(color.substring(3, 5), 16);
    let B = parseInt(color.substring(5, 7), 16);

    R = parseInt(R * (100 + percent) / 100);
    G = parseInt(G * (100 + percent) / 100);
    B = parseInt(B * (100 + percent) / 100);

    R = (R < 255) ? R : 255;
    G = (G < 255) ? G : 255;
    B = (B < 255) ? B : 255;

    const RR = ((R.toString(16).length == 1) ? "0" + R.toString(16) : R.toString(16));
    const GG = ((G.toString(16).length == 1) ? "0" + G.toString(16) : G.toString(16));
    const BB = ((B.toString(16).length == 1) ? "0" + B.toString(16) : B.toString(16));

    return "#" + RR + GG + BB;
}

// Setup navigation
function setupNavigation() {
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(item => {
        item.addEventListener('click', function() {
            const section = this.dataset.section;
            document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
            document.getElementById(`${section}-section`).classList.add('active');
            navItems.forEach(nav => nav.classList.remove('active'));
            this.classList.add('active');
        });
    });
}

// Setup all button event listeners
function setupButtons() {
    // Setup Semesters
    document.getElementById('setup-semesters-btn')?.addEventListener('click', function() {
        const count = parseInt(document.getElementById('semester-count').value) || 3;
        setupSemesters(count);
    });

    // Time slot
    document.getElementById('add-timeslot-btn')?.addEventListener('click', addTimeSlot);
    
    // Teacher
    document.getElementById('add-teacher-btn')?.addEventListener('click', addTeacher);
    
    // Subject
    document.getElementById('add-subject-btn')?.addEventListener('click', addSubject);
    
    // Classroom
    document.getElementById('add-classroom-btn')?.addEventListener('click', addClassroom);
    
    // Generate
    document.getElementById('generate-btn')?.addEventListener('click', generateTimetable);
    
    // Export
    document.getElementById('export-pdf-btn')?.addEventListener('click', exportPDF);
    document.getElementById('export-excel-btn')?.addEventListener('click', exportExcel);
    
    // Modal
    document.getElementById('close-modal')?.addEventListener('click', closeEditModal);
    document.getElementById('cancel-edit-btn')?.addEventListener('click', closeEditModal);
    document.getElementById('save-edit-btn')?.addEventListener('click', saveEdit);
    
    // Confirm Modal
    document.getElementById('close-confirm-modal')?.addEventListener('click', closeConfirmModal);
    document.getElementById('cancel-confirm-btn')?.addEventListener('click', closeConfirmModal);
    document.getElementById('confirm-action-btn')?.addEventListener('click', () => {
        if (confirmCallback) confirmCallback();
        closeConfirmModal();
    });

    // Enter key support
    document.getElementById('new-timeslot')?.addEventListener('keypress', e => {
        if (e.key === 'Enter') addTimeSlot();
    });
    document.getElementById('classroom-name')?.addEventListener('keypress', e => {
        if (e.key === 'Enter') addClassroom();
    });
    document.getElementById('teacher-name')?.addEventListener('keypress', e => {
        if (e.key === 'Enter') addTeacher();
    });
    document.getElementById('subject-name')?.addEventListener('keypress', e => {
        if (e.key === 'Enter') addSubject();
    });
    document.getElementById('sessions-per-week')?.addEventListener('keypress', e => {
        if (e.key === 'Enter') addSubject();
    });
    
    // Subject selection handler - update teacher dropdown
    document.getElementById('subject-name')?.addEventListener('change', e => {
        updateTeacherDropdown(e.target.value);
    });
    document.getElementById('subject-name')?.addEventListener('input', e => {
        updateTeacherDropdown(e.target.value);
    });
    
    // Handle subject selection from dropdown options
    document.getElementById('subject-options')?.addEventListener('click', e => {
        const li = e.target.closest('li');
        if (li && !li.classList.contains('disabled')) {
            const selectedValue = li.getAttribute('data-value');
            setTimeout(() => updateTeacherDropdown(selectedValue), 0);
        }
    });
    
    // Time slot removal
    document.getElementById('time-slots-container')?.addEventListener('click', function(e) {
        if (e.target.classList.contains('fa-times')) {
            const tag = e.target.parentElement;
            const timeSlot = tag.textContent.replace('×', '').trim();
            showConfirm(`Are you sure you want to delete time slot "${timeSlot}"?`, () => {
                tag.remove();
                showNotification('Time slot removed', 'success');
            });
        }
    });

    // Classroom filter removed
    
    setupTeacherAvailabilityUI();
}

function setupTeacherAvailabilityUI() {
    const container = document.getElementById('teacher-availability-container');
    if (!container) return;

    // Synchronize initial state
    syncTeacherAvailabilityDays();

    // Listen for changes in schedule configuration days
    document.querySelectorAll('.day-checkbox').forEach(cb => {
        cb.addEventListener('change', syncTeacherAvailabilityDays);
    });

    container.addEventListener('change', function(e) {
        if (e.target.classList.contains('teacher-day')) {
            const checkbox = e.target;
            const dayItem = checkbox.closest('.day-availability-item');
            const slotsContainer = dayItem.querySelector('.day-time-slots');
            const select = slotsContainer.querySelector('.day-slots-select');

            if (checkbox.checked) {
                const slots = getTimeSlots();
                select.innerHTML = slots.map(s => `<option value="${s}">${s}</option>`).join('');
                slotsContainer.style.display = 'block';
            } else {
                slotsContainer.style.display = 'none';
                select.innerHTML = '';
            }
        }
    });
}

function syncTeacherAvailabilityDays() {
    const selectedDays = Array.from(document.querySelectorAll('.day-checkbox:checked')).map(cb => cb.value);
    
    document.querySelectorAll('.day-availability-item').forEach(item => {
        const dayCheckbox = item.querySelector('.teacher-day');
        if (dayCheckbox) {
            const dayValue = dayCheckbox.value;
            if (selectedDays.includes(dayValue)) {
                item.style.display = 'block';
            } else {
                item.style.display = 'none';
                // Also uncheck and hide slots if day is now unavailable
                dayCheckbox.checked = false;
                const slotsContainer = item.querySelector('.day-time-slots');
                if (slotsContainer) {
                    slotsContainer.style.display = 'none';
                    const select = slotsContainer.querySelector('.day-slots-select');
                    if (select) select.innerHTML = '';
                }
            }
        }
    });
}

// Semester Management
function setupSemesters(count) {
    semesters = [];
    for (let i = 1; i <= count; i++) {
        semesters.push(`Semester ${i}`);
    }
    
    renderSemesters();
    updateSubjectSemesterDropdown();
    showNotification(`✅ ${count} semester(s) configured`, 'success');
}

function renderSemesters() {
    const container = document.getElementById('semesters-list');
    if (semesters.length === 0) {
        container.innerHTML = '';
        return;
    }
    
    container.innerHTML = `
        <div style="margin-top: 1rem;">
            <strong style="color: var(--dark-color);">Configured Semesters:</strong>
            <div style="margin-top: 0.75rem;">
                ${semesters.map(sem => `<div class="semester-item"><i class="fas fa-layer-group"></i> ${sem}</div>`).join('')}
            </div>
        </div>
    `;
}

function updateSubjectSemesterDropdown() {
    const select = document.getElementById('subject-semester');
    if (!select) return;
    
    select.innerHTML = semesters.map(sem => 
        `<option value="${sem}">${sem}</option>`
    ).join('');
}



// Time Slots
function addTimeSlot() {
    const input = document.getElementById('new-timeslot');
    const value = input.value.trim();

    if (!value) {
        showNotification('Please enter a time slot', 'error');
        return;
    }

    // Check for duplicates
    const existingSlots = getTimeSlots();
    if (existingSlots.includes(value)) {
        showNotification('This time slot already exists.', 'error');
        return;
    }

    const container = document.querySelector('#time-slots-container .input-tag-group');
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.innerHTML = `${value} <i class="fas fa-times"></i>`;
    container.appendChild(tag);

    input.value = '';
    showNotification('Time slot added: ' + value, 'success');
}

// Teachers
function addTeacher() {
    const nameInput = document.getElementById('teacher-name');
    const hiddenSubjectsInput = document.getElementById('teacher-subjects');
    const tagsContainer = document.getElementById('teacher-subjects-tags');
    const freeTextInput = document.getElementById('teacher-subjects-input');

    const name = nameInput.value.trim();

    // Build subject list strictly from current tags; fallback to hidden/comma if no tags present
    let subjectsList = [];
    if (tagsContainer && tagsContainer.querySelectorAll('.tag').length > 0) {
        subjectsList = Array.from(tagsContainer.querySelectorAll('.tag'))
            .map(tag => (tag.textContent || '').replace('×', '').trim())
            .filter(Boolean);
    } else if (hiddenSubjectsInput) {
        const subjectsStr = hiddenSubjectsInput.value.trim();
        if (subjectsStr) subjectsList = subjectsStr.split(',').map(s => s.trim()).filter(Boolean);
    }

    if (!name || subjectsList.length === 0) {
        showNotification('Please fill in teacher name and subjects', 'error');
        return;
    }

    // Check for duplicate teacher name (case-insensitive)
    if (teachers.some(t => t.name.toLowerCase() === name.toLowerCase())) {
        showNotification('This teacher has already been added.', 'error');
        return;
    }

    const availability = {};
    const dayItems = document.querySelectorAll('.day-availability-item');
    let hasSelection = false;

    dayItems.forEach(item => {
        const checkbox = item.querySelector('.teacher-day');
        if (checkbox.checked) {
            hasSelection = true;
            const select = item.querySelector('.day-slots-select');
            const selectedSlots = Array.from(select.selectedOptions).map(o => o.value);
            availability[checkbox.value] = selectedSlots;
        }
    });

    teachers.push({
        name: name,
        subjects: subjectsList,
        availability: availability
    });

    renderTeachers();

    // Full reset after add to prevent carry-over
    nameInput.value = '';
    if (hiddenSubjectsInput) hiddenSubjectsInput.value = '';
    if (tagsContainer) tagsContainer.innerHTML = '';
    if (freeTextInput) freeTextInput.value = '';
    // Notify the inline multi-select script to reset its internal array
    window.dispatchEvent(new Event('reset-teacher-subjects'));

    document.querySelectorAll('.teacher-day').forEach(cb => {
        cb.checked = false;
        // Trigger change to hide slots
        cb.dispatchEvent(new Event('change', { bubbles: true }));
    });
    // Also manually hide/clear just in case
    document.querySelectorAll('.day-time-slots').forEach(div => {
        div.style.display = 'none';
        div.querySelector('select').innerHTML = '';
    });

    const subjOptions = document.getElementById('teacher-subjects-options');
    if (subjOptions) subjOptions.style.display = 'none';
    const nameOptions = document.getElementById('teacher-options');
    if (nameOptions) nameOptions.style.display = 'none';
    const subjWrapper = document.getElementById('teacher-subjects-select');
    if (subjWrapper) subjWrapper.classList.remove('open');
    const nameWrapper = document.getElementById('teacher-select');
    if (nameWrapper) nameWrapper.classList.remove('open');

    // Ensure any internal selection state used by the subject multi-select script is cleared
    try {
        const event = new Event('input');
        if (freeTextInput) freeTextInput.dispatchEvent(event);
    } catch (e) {}

    showNotification('✅ Teacher added: ' + name, 'success');
}

function removeTeacher(index) {
    const teacher = teachers[index];
    const name = teacher ? teacher.name : 'this teacher';
    showConfirm(`Are you sure you want to delete teacher "${name}"?`, () => {
        teachers.splice(index, 1);
        renderTeachers();
        showNotification('Teacher removed', 'success');
    });
}

function renderTeachers() {
    const container = document.getElementById('teachers-list');
    
    if (teachers.length === 0) {
        container.innerHTML = '<p style="color: var(--text-light); font-style: italic;">No teachers added yet.</p>';
        return;
    }
    
    container.innerHTML = teachers.map((teacher, index) => {
        const availableDays = Object.keys(teacher.availability).join(', ') || 'All days';
        const subjectBadges = teacher.subjects.map(s => `<span class="item-badge">${s}</span>`).join('');
        
        return `
            <div class="item">
                <div class="item-content">
                    <div class="item-title"><i class="fas fa-user"></i> ${teacher.name}</div>
                    <div class="item-details">${subjectBadges}</div>
                    <div class="item-details" style="margin-top: 0.5rem;">
                        <i class="fas fa-calendar-check"></i> Available: ${availableDays}
                    </div>
                </div>
                <div class="item-actions">
                    <button class="btn btn-danger btn-icon remove-teacher-btn" data-index="${index}">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            </div>
        `;
    }).join('');
    
    container.querySelectorAll('.remove-teacher-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            removeTeacher(parseInt(this.getAttribute('data-index')));
        });
    });
}

// Subjects
function addSubject() {
    const semesterSelect = document.getElementById('subject-semester');
    const nameInput = document.getElementById('subject-name');
    const sessionsInput = document.getElementById('sessions-per-week');
    const deptInput = document.getElementById('department-name');
    const deptTags = document.getElementById('department-tags-below');
    const teacherSelect = document.getElementById('subject-teacher');
    
    const semester = semesterSelect.value;
    const name = nameInput.value.trim();
    const sessions = parseInt(sessionsInput.value) || 2;
    const selectedTeacherId = teacherSelect.value.trim();

    // Collect selected departments from tags (fallback to comma-separated input)
    let departments = [];
    if (deptTags) {
        departments = Array.from(deptTags.querySelectorAll('.tag'))
            .map(tag => (tag.textContent || '').replace('×', '').trim())
            .filter(Boolean);
    }
    if (departments.length === 0 && deptInput) {
        const raw = deptInput.value.trim();
        if (raw) departments = raw.split(',').map(s => s.trim()).filter(Boolean);
    }
    
    if (!name) {
        showNotification('Please select a subject name', 'error');
        return;
    }
    
    if (departments.length === 0) {
        showNotification('Please select at least one department', 'error');
        return;
    }
    
    if (!selectedTeacherId) {
        showNotification('Please select a teacher for this subject', 'error');
        return;
    }
    
    // Find the teacher name from the ID
    const selectedTeacher = teachers.find(t => t.name === selectedTeacherId);
    if (!selectedTeacher) {
        showNotification('Invalid teacher selection', 'error');
        return;
    }
    
    // Check for duplicate Subject-Teacher combinations for this semester
    const duplicate = subjects.some(s => 
        s.name === name && 
        s.semester === semester &&
        s.teacher_id === selectedTeacherId
    );
    if (duplicate) {
        showNotification(`Subject "${name}" with this teacher already exists for ${semester}`, 'error');
        return;
    }
    
    // Add one entry for all departments with the selected teacher
    subjects.push({
        name: name,
        semester: semester,
        sessions_per_week: sessions,
        departments: departments,
        teacher_id: selectedTeacherId,
        teacher_name: selectedTeacher.name
    });
    
    renderSubjects();
    
    // Reset fields
    nameInput.value = '';
    sessionsInput.value = '2';
    if (deptInput) deptInput.value = '';
    if (deptTags) deptTags.innerHTML = '';
    teacherSelect.value = '';
    teacherSelect.disabled = true;
    const teacherHelpText = document.getElementById('teacher-help-text');
    if (teacherHelpText) teacherHelpText.style.display = 'none';
    const deptOptions = document.getElementById('department-options');
    const deptWrapper = document.getElementById('department-select');
    if (deptOptions) deptOptions.style.display = 'none';
    if (deptWrapper) deptWrapper.classList.remove('open');
    // Reset internal selection state of Department multi-select
    try { window.dispatchEvent(new Event('reset-department-selection')); } catch(e){}
    
    showNotification(`✅ Subject added: ${name}`, 'success');
}

function removeSubject(index) {
    const subject = subjects[index];
    const name = subject ? subject.name : 'this subject';
    showConfirm(`Are you sure you want to delete subject "${name}"?`, () => {
        subjects.splice(index, 1);
        renderSubjects();
        showNotification('Subject removed', 'success');
    });
}

function renderSubjects() {
    const container = document.getElementById('subjects-list');
    
    if (subjects.length === 0) {
        container.innerHTML = '<p style="color: var(--text-light); font-style: italic;">No subjects added yet.</p>';
        return;
    }
    
    container.innerHTML = subjects.map((subject, index) => {
        const deptDisplay = Array.isArray(subject.departments) && subject.departments.length ? subject.departments.join(', ') : '';
        const teacherDisplay = subject.teacher_name ? `<span class="item-badge" style="background: #e8f5e9; color: #2e7d32;"><i class="fas fa-user-check"></i> ${subject.teacher_name}</span>` : '';
        return `
        <div class="item">
            <div class="item-content">
                <div class="item-title">
                    <i class="fas fa-book"></i> ${subject.name}
                    <span class="semester-badge">${subject.semester}</span>
                    <span class="sessions-badge">${subject.sessions_per_week}x/week</span>
                </div>
                <div class="item-details">
                    ${deptDisplay ? `<span class="item-badge">${deptDisplay}</span>` : ''}
                    ${teacherDisplay}
                </div>
            </div>
            <div class="item-actions">
                <button class="btn btn-danger btn-icon remove-subject-btn" data-index="${index}">
                    <i class="fas fa-trash"></i>
                </button>
            </div>
        </div>`;
    }).join('');
    
    container.querySelectorAll('.remove-subject-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            removeSubject(parseInt(this.getAttribute('data-index')));
        });
    });
}

// Update teacher dropdown based on selected subject
function updateTeacherDropdown(selectedSubjectName) {
    const teacherSelect = document.getElementById('subject-teacher');
    const teacherHelpText = document.getElementById('teacher-help-text');
    
    if (!selectedSubjectName || selectedSubjectName.trim() === '') {
        teacherSelect.disabled = true;
        teacherSelect.innerHTML = '<option value="">Select a teacher...</option>';
        if (teacherHelpText) teacherHelpText.style.display = 'block';
        return;
    }
    
    // Find teachers who can teach the selected subject (case-insensitive)
    const subjectKey = selectedSubjectName.toLowerCase();
    const availableTeachers = teachers.filter(teacher => {
        const teacherSubjects = (teacher.subjects || []).map(s => (s || '').toLowerCase());
        return teacherSubjects.includes(subjectKey);
    });
    
    if (availableTeachers.length === 0) {
        teacherSelect.disabled = true;
        teacherSelect.innerHTML = '<option value="">No teachers available for this subject</option>';
        if (teacherHelpText) {
            teacherHelpText.textContent = 'No teachers are assigned to this subject in the Teacher section';
            teacherHelpText.style.display = 'block';
        }
        return;
    }
    
    // Populate dropdown with available teachers
    teacherSelect.disabled = false;
    teacherSelect.innerHTML = '<option value="">Select a teacher...</option>' + 
        availableTeachers.map(t => `<option value="${t.name}">${t.name}</option>`).join('');
    if (teacherHelpText) teacherHelpText.style.display = 'none';
}

// Classrooms
function addClassroom() {
    const input = document.getElementById('classroom-name');
    const value = input.value.trim();
    
    if (!value) {
        showNotification('Please enter a classroom name', 'error');
        return;
    }
    
    if (classrooms.includes(value)) {
        showNotification('Classroom already exists', 'error');
        return;
    }
    
    classrooms.push(value);
    renderClassrooms();
    input.value = '';
    showNotification('✅ Classroom added: ' + value, 'success');
}

function removeClassroom(classroom) {
    showConfirm(`Are you sure you want to delete classroom "${classroom}"?`, () => {
        classrooms = classrooms.filter(c => c !== classroom);
        renderClassrooms();
        showNotification('Classroom removed', 'success');
    });
}

function renderClassrooms() {
    const container = document.querySelector('#classrooms-list .input-tag-group');
    
    if (classrooms.length === 0) {
        container.innerHTML = '<p style="color: var(--text-light); font-style: italic;">No classrooms added yet.</p>';
        return;
    }
    
    container.innerHTML = classrooms.map(classroom => 
        `<span class="tag">${classroom} <i class="fas fa-times remove-classroom-btn" data-classroom="${classroom}"></i></span>`
    ).join('');
    
    container.querySelectorAll('.remove-classroom-btn').forEach(icon => {
        icon.addEventListener('click', function() {
            removeClassroom(this.getAttribute('data-classroom'));
        });
    });
}

// Generate Timetable
async function generateTimetable() {
    const days = getSelectedDays();
    const timeSlots = getTimeSlots();
    
    if (teachers.length === 0 || subjects.length === 0 || classrooms.length === 0) {
        showNotification('❌ Please add teachers, subjects, and classrooms first', 'error');
        return;
    }
    
    if (days.length === 0 || timeSlots.length === 0) {
        showNotification('❌ Please select days and time slots', 'error');
        return;
    }
    
    if (semesters.length === 0) {
        showNotification('❌ Please setup semesters first', 'error');
        return;
    }
    
    showLoading(true);
    
    try {
        // Ensure mandatory break slot is present and sort slots
        const BREAK_SLOT = "11:30 – 01:00";
        let finalTimeSlots = [...timeSlots];
        if (!finalTimeSlots.includes(BREAK_SLOT)) {
            finalTimeSlots.push(BREAK_SLOT);
        }
        finalTimeSlots = sortTimeSlots(finalTimeSlots);

        // Validate duplicates
        const teacherNames = teachers.map(t => (t.name || '').trim().toLowerCase());
        if (new Set(teacherNames).size !== teacherNames.length) {
            throw new Error('Duplicate teachers detected. Please ensure each teacher is unique.');
        }

        if (new Set(finalTimeSlots).size !== finalTimeSlots.length) {
            throw new Error('Duplicate time slots detected. Please ensure each time slot is unique.');
        }

        const generator = new TimetableGenerator(teachers, subjects, classrooms, finalTimeSlots, days, semesters);
        const result = generator.generate();

        currentSessionId = currentSessionId || Math.random().toString(36).substring(2, 10);
        
        timetablesStore[currentSessionId] = {
            timetable: result.timetable,
            conflicts: result.conflicts,
            metadata: {
                classrooms: classrooms,
                days: days,
                timeSlots: finalTimeSlots,
                semesters: semesters
            }
        };

        sessionMemoryStore[currentSessionId] = {
            teachers: [...teachers],
            subjects: [...subjects],
            classrooms: [...classrooms],
            timeSlots: finalTimeSlots,
            days: days,
            semesters: semesters,
            last_updated: new Date().toISOString()
        };

        currentTimetable = result.timetable;
        currentMetadata = timetablesStore[currentSessionId].metadata;
        
        updateClassroomFilter();
        renderTimetable(currentTimetable, classrooms, days, finalTimeSlots);
        renderConflicts(result.conflicts);
        
        // Update export buttons session id
        document.getElementById('export-pdf-btn').dataset.sessionId = currentSessionId;
        document.getElementById('export-excel-btn').dataset.sessionId = currentSessionId;
        
        // Switch to timetable view
        document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
        document.getElementById('timetable-section').classList.add('active');
        
        document.querySelectorAll('.nav-item').forEach(item => {
            item.classList.remove('active');
            if (item.dataset.section === 'timetable') {
                item.classList.add('active');
            }
        });
        
        showNotification('🎉 Timetable generated successfully!', 'success');
    } catch (error) {
        console.error('Error:', error);
        showNotification('❌ Error generating timetable: ' + error.message, 'error');
    } finally {
        showLoading(false);
    }
}

// Classroom filter removed
function updateClassroomFilter() {}
function filterTimetableByClassroom() {}

// Popup (rebuilt): helpers for combo dropdowns
function buildCombo(inputEl, listEl, sourceFn) {
    if (!inputEl || !listEl) return;
    let open = false;
    function openList() { listEl.parentElement.classList.add('open'); open = true; }
    function closeList() { listEl.parentElement.classList.remove('open'); open = false; }
    function render(filter=''){
        const items = sourceFn(filter);
        listEl.innerHTML = items.length ? items.map(v => `<li data-value="${v}">${v}</li>`).join('') : '<li class="disabled">No matches</li>';
    }
    inputEl.addEventListener('focus', ()=>{ render(inputEl.value.trim()); openList(); });
    inputEl.addEventListener('input', ()=>{ render(inputEl.value.trim()); openList(); });
    listEl.addEventListener('click', (e)=>{
        const li = e.target.closest('li');
        if (!li || li.classList.contains('disabled')) return;
        const val = li.getAttribute('data-value');
        inputEl.value = val;
        closeList();
    });
    document.addEventListener('click', (e)=>{ if(!(listEl.parentElement.contains(e.target))) closeList(); });
    inputEl.addEventListener('keydown', (e)=>{ if (e.key === 'Escape') closeList(); });
}

// Render Timetable (Layout: Days on left, Time slots on top)
function renderTimetable(timetable, classroomsToShow, days, timeSlots) {
    const container = document.getElementById('timetable-container');
    
    if (!timetable || timetable.length === 0) {
        container.innerHTML = '<p class="empty-state"><i class="fas fa-calendar-times"></i><br>No classes scheduled.</p>';
        return;
    }
    
    let html = '';

    // Unified table (all classrooms combined per slot, multiple lines)
    html += `
        <div class="timetable-card">
            <h3 class="timetable-classroom-title">
                <i class="fas fa-calendar"></i>
                Unified Timetable
            </h3>
            <div class="timetable-wrapper">
                <table class="timetable">
                    <thead>
                        <tr>
                            <th>Day / Time</th>
                            ${timeSlots.map(slot => `<th>${slot}</th>`).join('')}
                        </tr>
                    </thead>
                    <tbody>
    `;

    days.forEach((day, dayIndex) => {
        html += `<tr><td>${day}</td>`;
        timeSlots.forEach(slot => {
            const isBreakSlot = slot === "11:30 – 01:00";
            
            // Handle vertical merge for break slot
            if (isBreakSlot) {
                if (dayIndex === 0) {
                    // Render the merged cell only on the first day
                    const cellAttrs = `data-slot="${slot}" rowspan="${days.length}"`;
                    html += `<td class="timetable-cell break-slot merged-break" ${cellAttrs}></td>`;
                }
                // Skip rendering for subsequent days
                return;
            }

            const entries = timetable.filter(e => e.day === day && e.time_slot === slot);
            const cellAttrs = `data-day="${day}" data-slot="${slot}"`;
            const breakSlotClass = ''; // isBreakSlot handled above
            
            if (entries && entries.length) {
                const cells = entries.map(e => {
                    const idx = timetable.indexOf(e);
                    const bg = colorForSubject(e.subject);
                    const rooms = (Array.isArray(e.classrooms) && e.classrooms.length) ? e.classrooms.join(', ') : '-';
                    return `
                        <div class="cell-block" draggable="true" style="background:${bg}" data-index="${idx}" title="Drag to move or click to edit">
                            <button class="cell-close-btn" type="button" title="Delete this cell">×</button>
                            <div class="cell-subject">${e.subject}</div>
                            <div class="cell-teacher"><i class="fas fa-user"></i> ${e.teacher}</div>
                            <div class="cell-meta">Rooms: ${rooms} • ${e.semester || ''}</div>
                            ${Array.isArray(e.department_codes) && e.department_codes.length ? `<div class="cell-meta">Dept: ${e.department_codes.join(', ')}</div>` : ''}
                            ${e.description ? `<div class="cell-meta">${e.description}</div>` : ''}
                        </div>
                    `;
                }).join('');
                html += `<td class="timetable-cell multi droptarget ${breakSlotClass}" ${cellAttrs}>${cells}</td>`;
            } else {
                html += `<td class="droptarget ${breakSlotClass}" ${cellAttrs}></td>`;
            }
        });
        html += '</tr>';
    });

    html += `
                    </tbody>
                </table>
            </div>
        </div>
    `;

    container.innerHTML = html;

    // Click handlers on blocks
    container.querySelectorAll('.cell-block').forEach(block => {
        block.addEventListener('click', function(e){
            e.stopPropagation();
            editEntry(parseInt(this.getAttribute('data-index')));
        });
        // Drag handlers
        block.addEventListener('dragstart', onDragStart);
        // Close button handler
        const closeBtn = block.querySelector('.cell-close-btn');
        if (closeBtn) {
            closeBtn.addEventListener('click', function(e){
                e.stopPropagation();
                const idx = parseInt(block.getAttribute('data-index'));
                deleteCellContent(idx);
            });
        }
    });

    // Drop targets
    container.querySelectorAll('.droptarget').forEach(cell => {
        const isBreakSlot = cell.classList.contains('break-slot');
        
        if (!isBreakSlot) {
            cell.addEventListener('dragover', onDragOver);
            cell.addEventListener('dragleave', onDragLeave);
            cell.addEventListener('drop', onDrop);
        }
        
        // Empty-cell add support
        cell.addEventListener('click', function(){
            // Only when no entries exist in this cell and not a break slot
            if (!this.querySelector('.cell-block') && !isBreakSlot) {
                const day = this.getAttribute('data-day');
                const slot = this.getAttribute('data-slot');
                openAddModal(day, slot);
            }
        });
    });
}

function deleteCellContent(index) {
    showConfirm('Are you sure you want to delete this cell content?', () => {
        if (currentTimetable && currentTimetable[index]) {
            currentTimetable[index] = {};
            const container = document.getElementById('timetable-container');
            const cell = container?.querySelector(`[data-index="${index}"]`);
            if (cell) {
                cell.remove();
            }
        }
    });
}

function openAddModal(day, slot){
    addTarget = { day, slot };
    editingIndex = null;

    const subInput = document.getElementById('combo-subject-input');
    const subList = document.getElementById('combo-subject-list');
    const teaInput = document.getElementById('combo-teacher-input');
    const teaList = document.getElementById('combo-teacher-list');
    const semSel = document.getElementById('dropdown-semester');
    const depSel = document.getElementById('dropdown-department');
    const clsWrap = document.getElementById('checkbox-classrooms');
    const desc = document.getElementById('text-description');

    if (subInput) subInput.value = '';
    if (teaInput) teaInput.value = '';
    if (desc) desc.value = '';

    buildCombo(subInput, subList, (q)=>
        (subjects||[]).map(s=>s.name).filter(Boolean).filter(v=>v.toLowerCase().includes((q||'').toLowerCase()))
    );
    buildCombo(teaInput, teaList, (q)=>
        (teachers||[]).map(t=>t.name).filter(Boolean).filter(v=>v.toLowerCase().includes((q||'').toLowerCase()))
    );

    if (semSel) {
        semSel.innerHTML = ['<option value="">Select</option>'].concat((semesters||[]).map(v=>`<option value="${v}">${v}</option>`)).join('');
        semSel.value = '';
    }

    if (depSel) {
        const set = new Set();
        (subjects||[]).forEach(s=>{ (s.departments||[]).forEach(d=>{ const abbr = String(d||'').split('–')[0].trim(); if (abbr) set.add(abbr); }); });
        depSel.innerHTML = Array.from(set).map(v=>`<option value="${v}">${v}</option>`).join('');
        Array.from(depSel.options).forEach(o=> o.selected=false);
    }

    if (clsWrap) {
        clsWrap.innerHTML = (classrooms||[]).map(c=>`<label><input type="checkbox" value="${c}"> ${c}</label>`).join('');
    }

    document.getElementById('edit-modal').classList.add('active');
}

// Drag-and-drop handlers
let draggedIndex = null;
function onDragStart(ev){
    draggedIndex = parseInt(ev.currentTarget.getAttribute('data-index'));
    ev.dataTransfer.setData('text/plain', String(draggedIndex));
    ev.dataTransfer.effectAllowed = 'move';
}
function onDragOver(ev){
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    ev.currentTarget.classList.add('drag-hover');
}
function onDragLeave(ev){
    ev.currentTarget.classList.remove('drag-hover');
}
async function onDrop(ev){
    ev.preventDefault();
    ev.currentTarget.classList.remove('drag-hover');
    
    // Prevent dropping on break slot
    if (ev.currentTarget.classList.contains('break-slot')) {
        showNotification('⏸️ Cannot drop class into break slot', 'warning');
        return;
    }
    
    const idx = draggedIndex ?? parseInt(ev.dataTransfer.getData('text/plain'));
    if (isNaN(idx)) return;
    const targetDay = ev.currentTarget.getAttribute('data-day');
    const targetSlot = ev.currentTarget.getAttribute('data-slot');
    if (!targetDay || !targetSlot) return;

    // Update local state
    currentTimetable[idx].day = targetDay;
    currentTimetable[idx].time_slot = targetSlot;

    try {
        const generator = new TimetableGenerator([], [], [], [], [], []);
        generator.timetable = [...currentTimetable];
        generator.days = currentMetadata.days;
        generator.time_slots = currentMetadata.timeSlots;
        generator.detectConflicts();
        
        if (currentSessionId && timetablesStore[currentSessionId]) {
            timetablesStore[currentSessionId].timetable = currentTimetable;
            timetablesStore[currentSessionId].conflicts = generator.conflicts;
        }

        renderTimetable(currentTimetable, classrooms, currentMetadata.days, currentMetadata.timeSlots);
        renderConflicts(generator.conflicts);
        flagConflictCells(generator.conflicts);
    } catch(err){
        console.error(err);
        showNotification('❌ Error updating after drag-and-drop: ' + err.message, 'error');
    }
}

function flagConflictCells(conflicts){
    const container = document.getElementById('timetable-container');
    container.querySelectorAll('.droptarget').forEach(c => c.classList.remove('conflict'));
    if (!Array.isArray(conflicts)) return;
    conflicts.forEach(c => {
        if (!c.day || !c.time_slot) return;
        const sel = `.droptarget[data-day="${c.day}"][data-slot="${c.time_slot}"]`;
        const cell = container.querySelector(sel);
        if (cell) cell.classList.add('conflict');
    });
}

// Render Conflicts
function renderConflicts(conflicts) {
    const container = document.getElementById('conflicts-container');
    
    if (!conflicts || conflicts.length === 0) {
        container.innerHTML = '<p class="empty-state"><i class="fas fa-check-circle"></i><br>No conflicts detected. All clear! ✅</p>';
        return;
    }
    
    container.innerHTML = conflicts.map(conflict => {
        let typeLabel = 'Conflict';
        if (conflict.type === 'teacher') typeLabel = 'Teacher Conflict';
        else if (conflict.type === 'classroom') typeLabel = 'Classroom Conflict';
        else if (conflict.type === 'student') typeLabel = 'Student Conflict';

        const details = `
            <div><strong>Day:</strong> ${conflict.day} <strong>Time:</strong> ${conflict.time_slot}</div>
            ${conflict.teacher ? `<div><strong>Teacher:</strong> ${conflict.teacher}</div>` : ''}
            ${conflict.classroom ? `<div><strong>Classroom:</strong> ${conflict.classroom}</div>` : ''}
            ${conflict.semester ? `<div><strong>Semester:</strong> ${conflict.semester}</div>` : ''}
            <div><i class="fas fa-book"></i> ${Array.isArray(conflict.subjects) ? conflict.subjects.join(', ') : ''}</div>
            ${conflict.suggestions && conflict.suggestions.length ? `<div class="conflict-suggestion"><i class="fas fa-lightbulb"></i> Suggested: ${conflict.suggestions.join(' | ')}</div>` : ''}
        `;

        return `
            <div class="conflict-item error">
                <div class="conflict-type"><i class="fas fa-exclamation-triangle"></i> ${typeLabel}</div>
                <div class="conflict-details">${details}</div>
            </div>
        `;
    }).join('');
}

// Edit Entry
function editEntry(index) {
    editingIndex = index;
    const entry = currentTimetable[index];

    const subInput = document.getElementById('combo-subject-input');
    const subList = document.getElementById('combo-subject-list');
    const teaInput = document.getElementById('combo-teacher-input');
    const teaList = document.getElementById('combo-teacher-list');
    const semSel = document.getElementById('dropdown-semester');
    const depSel = document.getElementById('dropdown-department');
    const clsWrap = document.getElementById('checkbox-classrooms');
    const desc = document.getElementById('text-description');

    if (subInput) subInput.value = entry.subject || '';
    if (teaInput) teaInput.value = entry.teacher || '';
    if (desc) desc.value = entry.description || '';

    buildCombo(subInput, subList, (q)=> (subjects||[]).map(s=>s.name).filter(Boolean).filter(v=>v.toLowerCase().includes((q||'').toLowerCase())));
    buildCombo(teaInput, teaList, (q)=> (teachers||[]).map(t=>t.name).filter(Boolean).filter(v=>v.toLowerCase().includes((q||'').toLowerCase())));

    if (semSel) {
        semSel.innerHTML = ['<option value="">Select</option>'].concat((semesters||[]).map(v=>`<option value="${v}">${v}</option>`)).join('');
        semSel.value = entry.semester || '';
    }

    if (depSel) {
        const set = new Set();
        (subjects||[]).forEach(s=>{ (s.departments||[]).forEach(d=>{ const abbr = String(d||'').split('–')[0].trim(); if (abbr) set.add(abbr); }); });
        depSel.innerHTML = Array.from(set).map(v=>`<option value="${v}">${v}</option>`).join('');
        const pre = Array.isArray(entry.department_codes) ? entry.department_codes : [];
        Array.from(depSel.options).forEach(opt => { opt.selected = pre.includes(opt.value); });
    }

    const selected = new Set(Array.isArray(entry.classrooms) ? entry.classrooms : []);
    if (clsWrap) {
        clsWrap.innerHTML = (classrooms||[]).map(c=>`<label><input type="checkbox" value="${c}" ${selected.has(c)?'checked':''}> ${c}</label>`).join('');
    }

    document.getElementById('edit-modal').classList.add('active');
}

function closeEditModal() {
    document.getElementById('edit-modal').classList.remove('active');
    editingIndex = null;
}

async function saveEdit() {
    const subject = (document.getElementById('combo-subject-input')?.value || '').trim();
    const teacher = (document.getElementById('combo-teacher-input')?.value || '').trim();
    const semester = (document.getElementById('dropdown-semester')?.value || '').trim();
    const depSelect = document.getElementById('dropdown-department');
    const departmentsSelected = depSelect ? Array.from(depSelect.selectedOptions).map(o=>o.value) : [];
    const description = (document.getElementById('text-description')?.value || '').trim();

    // Validate required fields: subject, teacher, semester, classrooms
    if (!subject) { showNotification('❌ Subject is required', 'error'); return; }
    if (!teacher) { showNotification('❌ Teacher is required', 'error'); return; }
    if (!semester) { showNotification('❌ Semester is required', 'error'); return; }
    const selectedClassrooms = Array.from(document.querySelectorAll('#checkbox-classrooms input[type="checkbox"]:checked')).map(cb => cb.value);
    if (selectedClassrooms.length === 0) { showNotification('❌ At least one classroom is required', 'error'); return; }

    const deptCodes = departmentsSelected;

    if (addTarget) {
        const classroomFallback = classrooms[0] || 'Room 1';
        const payload = {
            day: addTarget.day,
            time_slot: addTarget.slot,
            subject,
            teacher,
            semester,
            classrooms: selectedClassrooms.length ? selectedClassrooms : [classroomFallback],
            description,
            department_codes: deptCodes
        };
        currentTimetable.push(payload);
        addTarget = null;
    } else if (editingIndex !== null) {
        const e = currentTimetable[editingIndex];
        e.subject = subject;
        e.teacher = teacher;
        e.semester = semester;
        e.classrooms = selectedClassrooms.length ? selectedClassrooms : (Array.isArray(e.classrooms) && e.classrooms.length ? e.classrooms : [classrooms[0] || 'Room 1']);
        e.description = description;
        e.department_codes = deptCodes;
        if ('classroom' in e) delete e.classroom;
        if ('department_code' in e) delete e.department_code;
        if ('venue' in e) delete e.venue;
    } else {
        return;
    }

    try {
        const generator = new TimetableGenerator([], [], [], [], [], []);
        generator.timetable = [...currentTimetable];
        generator.days = currentMetadata.days;
        generator.time_slots = currentMetadata.timeSlots;
        generator.detectConflicts();
        
        if (currentSessionId && timetablesStore[currentSessionId]) {
            timetablesStore[currentSessionId].timetable = currentTimetable;
            timetablesStore[currentSessionId].conflicts = generator.conflicts;
        }

        renderTimetable(currentTimetable, classrooms, currentMetadata.days, currentMetadata.timeSlots);
        renderConflicts(generator.conflicts);
        flagConflictCells(generator.conflicts);
        closeEditModal();
        showNotification('✅ Timetable updated', 'success');
    } catch (error) {
        showNotification('❌ Error updating entry: ' + error.message, 'error');
    }
}

// Export Functions
function exportPDF() {
    if (!currentSessionId || !timetablesStore[currentSessionId]) {
        showNotification('❌ Please generate a timetable first', 'error');
        return;
    }
    
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({
        orientation: 'landscape',
        format: 'a3',
        unit: 'in'
    });

    const data = timetablesStore[currentSessionId];
    const { timetable, metadata, conflicts } = data;
    const { days, timeSlots } = metadata;

    // Header
    doc.setFontSize(22);
    doc.setTextColor(40, 90, 150);
    doc.text('Unified Weekly Timetable', 0.5, 0.7);

    // Table Data
    const tableData = [];
    const headers = ['Day / Time', ...timeSlots];
    
    days.forEach(day => {
        const row = [day];
        timeSlots.forEach(slot => {
            if (slot === "11:30 – 01:00") {
                row.push("BREAK");
                return;
            }
            const entries = timetable.filter(e => e.day === day && e.time_slot === slot);
            if (entries.length > 0) {
                const text = entries.map(e => {
                    const rooms = (e.classrooms || []).join(', ');
                    let str = `${rooms}: ${e.subject}\n${e.teacher} (${e.semester || '-'})`;
                    if (e.department_codes && e.department_codes.length) str += `\nDept: ${e.department_codes.join(', ')}`;
                    if (e.description) str += `\n${e.description}`;
                    return str;
                }).join('\n\n');
                row.push(text);
            } else {
                row.push("");
            }
        });
        tableData.push(row);
    });

    doc.autoTable({
        head: [headers],
        body: tableData,
        startY: 1.0,
        styles: {
            fontSize: 9,
            cellPadding: 0.1,
            valign: 'middle',
            halign: 'center',
            overflow: 'linebreak',
            lineWidth: 0.01,
            lineColor: [180, 190, 200]
        },
        headStyles: {
            fillColor: [44, 72, 122],
            textColor: 255,
            fontSize: 11,
            fontStyle: 'bold'
        },
        columnStyles: {
            0: { fillColor: [233, 239, 248], fontStyle: 'bold', textColor: [15, 48, 87], cellWidth: 1.2 }
        },
        didParseCell: function(data) {
            if (data.section === 'body' && data.column.index > 0) {
                const slot = timeSlots[data.column.index - 1];
                if (slot === "11:30 – 01:00") {
                    data.cell.styles.fillColor = [255, 243, 205];
                    data.cell.styles.textColor = [133, 100, 4];
                    data.cell.styles.fontStyle = 'bold';
                    data.cell.styles.fontSize = 14;
                } else if (data.cell.text && data.cell.text.length > 0 && data.cell.text[0] !== "") {
                    data.cell.styles.fillColor = [232, 245, 233];
                }
            }
        }
    });

    // Conflicts Page
    if (conflicts && conflicts.length > 0) {
        doc.addPage();
        doc.setFontSize(22);
        doc.setTextColor(40, 90, 150);
        doc.text('Conflicts', 0.5, 0.7);

        const conflictHeaders = ['Type', 'Day', 'Time', 'Teacher', 'Classroom', 'Semester', 'Subjects', 'Suggestions'];
        const conflictRows = conflicts.map(c => [
            c.type.charAt(0).toUpperCase() + c.type.slice(1),
            c.day || '-',
            c.time_slot || '-',
            c.teacher || '-',
            c.classroom || '-',
            c.semester || '-',
            (c.subjects || []).join(', '),
            (c.suggestions || []).join(', ')
        ]);

        doc.autoTable({
            head: [conflictHeaders],
            body: conflictRows,
            startY: 1.0,
            styles: { fontSize: 8 },
            headStyles: { fillColor: [44, 72, 122], textColor: 255 }
        });
    }

    doc.save(`timetable_${new Date().toISOString().replace(/[:.]/g, '-')}.pdf`);
    showNotification('📄 PDF export completed!', 'success');
}

function exportExcel() {
    if (!currentSessionId || !timetablesStore[currentSessionId]) {
        showNotification('❌ Please generate a timetable first', 'error');
        return;
    }

    const data = timetablesStore[currentSessionId];
    const { timetable, metadata } = data;
    const { days, timeSlots } = metadata;

    const wb = XLSX.utils.book_new();
    const wsData = [];

    // Title
    wsData.push(['Unified Weekly Timetable']);
    wsData.push([]); // Spacer

    // Headers
    const headers = ['Day / Time', ...timeSlots];
    wsData.push(headers);

    // Rows
    days.forEach(day => {
        const row = [day];
        timeSlots.forEach(slot => {
            if (slot === "11:30 – 01:00") {
                row.push("BREAK");
                return;
            }
            const entries = timetable.filter(e => e.day === day && e.time_slot === slot);
            if (entries.length > 0) {
                const text = entries.map(e => {
                    const rooms = (e.classrooms || []).join(', ');
                    let str = `${rooms}: ${e.subject}\n${e.teacher} (${e.semester || '-'})`;
                    if (e.department_codes && e.department_codes.length) str += `\nDept: ${e.department_codes.join(', ')}`;
                    if (e.description) str += `\n${e.description}`;
                    return str;
                }).join('\n\n');
                row.push(text);
            } else {
                row.push("");
            }
        });
        wsData.push(row);
    });

    const ws = XLSX.utils.aoa_to_sheet(wsData);

    // Basic styling (column widths)
    const colWidths = [{ wch: 15 }];
    timeSlots.forEach(() => colWidths.push({ wch: 30 }));
    ws['!cols'] = colWidths;

    XLSX.utils.book_append_sheet(wb, ws, "Timetable");
    XLSX.writeFile(wb, `timetable_${new Date().toISOString().replace(/[:.]/g, '-')}.xlsx`);
    showNotification('📊 Excel export completed!', 'success');
}

// Helper Functions
function getSelectedDays() {
    return Array.from(document.querySelectorAll('.day-checkbox:checked'))
        .map(cb => cb.value);
}

function getTimeSlots() {
    const tags = Array.from(document.querySelectorAll('#time-slots-container .tag'));
    return tags.map(tag => {
        const text = tag.textContent || tag.innerText;
        return text.replace(/×/g, '').replace(/🍽️/g, '').trim();
    }).filter(t => t.length > 0);
}

function showLoading(show) {
    const overlay = document.getElementById('loading-overlay');
    if (show) {
        overlay.classList.add('active');
    } else {
        overlay.classList.remove('active');
    }
}

function showNotification(message, type = 'info') {
    const container = document.getElementById('notification-container');
    if (!container) return;

    const notif = document.createElement('div');
    notif.className = `notification ${type}`;
    
    let icon = 'fa-info-circle';
    if (type === 'success') icon = 'fa-check-circle';
    if (type === 'error') icon = 'fa-exclamation-circle';

    notif.innerHTML = `
        <i class="fas ${icon} notification-icon"></i>
        <div class="notification-content">${message}</div>
        <i class="fas fa-times notification-close"></i>
    `;

    // Close button
    notif.querySelector('.notification-close').addEventListener('click', () => {
        closeNotification(notif);
    });

    // Auto dismiss
    setTimeout(() => {
        closeNotification(notif);
    }, 5000);

    container.appendChild(notif);
}

function closeNotification(notif) {
    notif.style.animation = 'fadeOut 0.3s ease forwards';
    notif.addEventListener('animationend', () => {
        notif.remove();
    });
}

// Custom Confirm
let confirmCallback = null;

function showConfirm(message, onConfirm) {
    const modal = document.getElementById('confirm-modal');
    const msgEl = document.getElementById('confirm-message');
    if (!modal || !msgEl) {
        // Fallback if modal missing
        if (confirm(message)) onConfirm();
        return;
    }

    msgEl.textContent = message;
    confirmCallback = onConfirm;
    modal.classList.add('active');
}

function closeConfirmModal() {
    document.getElementById('confirm-modal').classList.remove('active');
    confirmCallback = null;
}

function renderAll() {
    renderTeachers();
    renderSubjects();
    renderClassrooms();
}

// UI helper removed: checkboxes are rendered directly when opening the modal

// Helper: Populate Department options with ALL departments (multi-select)
function populateDepartmentOptions(selectEl){
    if (!selectEl) return;
    const set = new Set();
    (subjects || []).forEach(s => {
        if (Array.isArray(s.departments)) s.departments.forEach(d => { const v = String(d || '').trim(); if (v) set.add(v); });
    });
    const options = Array.from(set);
    const previous = Array.from(selectEl.selectedOptions || []).map(o => o.value);
    selectEl.innerHTML = ['<option value="" disabled>-- Select --</option>'].concat(options.map(v => `<option value="${v}">${v}</option>`)).join('');
    // Re-select any previously selected values that still exist
    previous.forEach(v => { const opt = Array.from(selectEl.options).find(o => o.value === v); if (opt) opt.selected = true; });
}