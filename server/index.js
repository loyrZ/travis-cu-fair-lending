"use strict";
require("dotenv").config();

const express = require("express");
const path = require("path");
const cors = require("cors");

const apiRoutes = require("./routes/api");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// API routes
app.use("/api", apiRoutes);

// Static frontend (served from /public)
app.use(express.static(path.join(__dirname, "..", "public")));

// Fallback to index.html for client-side routing (if you add it later)
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.listen(PORT, () => {
    console.log(`Fair-lending tool running at http://localhost:${PORT}`);
});