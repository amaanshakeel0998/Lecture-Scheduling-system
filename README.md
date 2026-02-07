# Lecture Scheduling System

A single-page, browser-based timetable generator for universities. It lets you define semesters, days, time slots, teachers, subjects, and classrooms, then generates a timetable with conflict detection and export options.

## Developer
- Muhammad Amaan

## Features
- Semester configuration with multi-semester support
- Customizable days and time slots
- Teachers with subject assignments and optional availability
- Subjects/classes with semester, department, and sessions-per-week
- Auto-generated timetable with conflict detection and suggestions
- Inline edits for timetable cells and conflict highlighting
- Export to PDF and Excel
- Theme customization with presets and persistent storage

## Tech Stack
- HTML, CSS, JavaScript (no build step)
- Client-side only (in-memory data during session)
- LocalStorage for theme preferences
- CDN libraries for export: `xlsx`, `jspdf`, `jspdf-autotable`, `font-awesome`

## Getting Started
1. Clone or download this repository.
2. Open `index.html` in your browser.
   - Optional: use a local server for best results (e.g., VS Code Live Server).

## How To Use
1. Configure semesters, days, and time slots.
2. Add teachers, subjects/classes, and classrooms.
3. Click **Generate Timetable** to build a schedule.
4. Review the **Conflicts** tab for issues and suggestions.
5. Edit timetable entries if needed, then export to PDF or Excel.

## Notes
- All data is stored in memory during a session and is not persisted across reloads.
- Theme preferences are saved in LocalStorage.

## Project Structure
- `index.html` — UI structure and inline helpers
- `style.css` — Visual styling
- `main.js` — Timetable generation, conflict detection, exports, and UI logic
