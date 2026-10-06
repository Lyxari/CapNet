require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// AI-powered metadata extraction route (uses Google Gemini).
// Mounted under /api/nlp, so its internal '/process-capstone' route becomes:
//   POST /api/nlp/process-capstone
// which matches the URL dashboard.js already calls.
const nlpRouter = require('./nlp-route');
app.use('/api/nlp', nlpRouter);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
