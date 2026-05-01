"use strict";
require("dotenv").config();

/**
 * v5: Train a feedforward neural network to predict denial probability.
 *
 * Pipeline:
 *   1. Pull all HMDA loans from MySQL
 *   2. Filter out rows where outcome is ambiguous (withdrawn, file closed)
 *   3. Build a binary label: 1 = denied, 0 = originated
 *   4. One-hot encode categorical features, normalize numerics
 *   5. Train/test split (80/20, stratified by label)
 *   6. Train a small feedforward NN with dropout + early stopping
 *   7. Save model weights + a metadata JSON describing the encoding,
 *      so the predict endpoint can reconstruct inputs at serve time.
 *
 * Run:
 *   node scripts/trainModel.js
 *
 * Output:
 *   data/model/model.json + weights.bin   (TensorFlow.js model)
 *   data/model/encoder.json                (encoding metadata)
 */

const path = require("path");
const fs = require("fs");
const tf = require("@tensorflow/tfjs-node");
const mysql = require("mysql2/promise");

const OUTPUT_DIR = path.join(__dirname, "..", "data", "model");

// ---------- Feature config ----------
//
// IMPORTANT: only use features available AT APPLICATION TIME.
// Fields like interest_rate, total_loan_costs, etc. only get filled in
// AFTER an approval decision. Including them would cause label leakage
// (model "predicts" perfectly because denied apps have those blank).
//
// What's safe to use (an applicant has these when they apply):
//   - demographics: race, ethnicity, sex, age
//   - what they're asking for: loan amount, loan purpose, loan product type
//   - their finances at intake: income, debt-to-income ratio, LTV
//   - geography: county
//
// What we EXCLUDE (post-decision):
//   - interest_rate, action_taken (label), purchaser_type, anything in $
//     that's calculated at closing.

const NUMERIC_FEATURES = [
    "loan_amount",
    "income",
    "loan_to_value_ratio",
];

const CATEGORICAL_FEATURES = [
    "derived_race",
    "derived_ethnicity",
    "derived_sex",
    "applicant_age",
    "loan_purpose",
    "derived_loan_product_type",
    "debt_to_income_ratio",
    "county_code",
];

// ---------- Load data ----------

async function loadData() {
    const conn = await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        port: process.env.DB_PORT,
        database: process.env.DB_NAME,
    });

    const cols = [
        "action_taken",
        ...NUMERIC_FEATURES,
        ...CATEGORICAL_FEATURES,
    ].join(", ");

    const [rows] = await conn.query(`
        SELECT ${cols}
        FROM loans
        WHERE action_taken IN ('Loan originated', 'Application denied', 'Preapproval request denied')
    `);
    await conn.end();

    console.log(`Loaded ${rows.length} rows (originated + denied only).`);
    return rows;
}

// ---------- Preprocessing ----------

/**
 * Build the encoder: figure out the unique values for every categorical
 * feature, and the mean/std for every numeric feature, from the training set.
 * We then use this same encoder at predict time so encoding stays consistent.
 */
function buildEncoder(rows) {
    const encoder = { numeric: {}, categorical: {} };

    // Numeric: store mean and std for z-score normalization
    for (const col of NUMERIC_FEATURES) {
        const vals = rows.map(r => r[col]).filter(v => v != null && !isNaN(Number(v))).map(Number);
        if (vals.length === 0) {
            encoder.numeric[col] = { mean: 0, std: 1 };
            continue;
        }
        const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
        const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length;
        const std = Math.sqrt(variance) || 1;
        encoder.numeric[col] = { mean, std };
    }

    // Categorical: unique values, sorted, plus an "Unknown" bucket for nulls
    for (const col of CATEGORICAL_FEATURES) {
        const uniq = new Set();
        for (const r of rows) {
            const v = r[col];
            uniq.add(v == null ? "__UNKNOWN__" : String(v));
        }
        // Always include UNKNOWN even if no nulls in training, so predict time
        // can fall back to it for unseen values.
        uniq.add("__UNKNOWN__");
        encoder.categorical[col] = Array.from(uniq).sort();
    }

    // Compute total feature count
    let dim = NUMERIC_FEATURES.length;
    for (const col of CATEGORICAL_FEATURES) dim += encoder.categorical[col].length;
    encoder.input_dim = dim;

    return encoder;
}

/**
 * Encode a single row into a flat numeric vector using the encoder.
 * Returns a Float32Array of length encoder.input_dim.
 */
function encodeRow(row, encoder) {
    const vec = [];

    // Numeric: z-score normalize. NaN -> 0 (mean).
    for (const col of NUMERIC_FEATURES) {
        const raw = row[col];
        const num = raw == null || isNaN(Number(raw)) ? null : Number(raw);
        const { mean, std } = encoder.numeric[col];
        vec.push(num == null ? 0 : (num - mean) / std);
    }

    // Categorical: one-hot
    for (const col of CATEGORICAL_FEATURES) {
        const choices = encoder.categorical[col];
        const val = row[col] == null ? "__UNKNOWN__" : String(row[col]);
        const idx = choices.indexOf(val);
        const fallbackIdx = choices.indexOf("__UNKNOWN__");
        for (let i = 0; i < choices.length; i++) {
            vec.push(i === (idx >= 0 ? idx : fallbackIdx) ? 1 : 0);
        }
    }

    return vec;
}

function buildLabel(row) {
    // 1 = denied, 0 = originated
    if (row.action_taken === "Loan originated") return 0;
    return 1; // Application denied or Preapproval request denied
}

// ---------- Train/test split (stratified) ----------

function stratifiedSplit(rows, testRatio = 0.2, seed = 42) {
    // Simple deterministic shuffle using a seeded PRNG
    const rng = mulberry32(seed);
    const denied = rows.filter(r => buildLabel(r) === 1);
    const originated = rows.filter(r => buildLabel(r) === 0);

    function shuffle(arr) {
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(rng() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    }
    shuffle(denied);
    shuffle(originated);

    const dCut = Math.floor(denied.length * testRatio);
    const oCut = Math.floor(originated.length * testRatio);

    const test = [...denied.slice(0, dCut), ...originated.slice(0, oCut)];
    const train = [...denied.slice(dCut), ...originated.slice(oCut)];

    shuffle(train);
    shuffle(test);

    return { train, test };
}

// Tiny seeded PRNG so train/test split is reproducible
function mulberry32(seed) {
    return function() {
        let t = seed += 0x6D2B79F5;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

// ---------- Model ----------

function buildModel(inputDim) {
    // Deliberately small. With ~1,400 training rows, anything bigger
    // overfits within a couple epochs.
    const model = tf.sequential();

    model.add(tf.layers.dense({
        inputShape: [inputDim],
        units: 16,
        activation: "relu",
        kernelInitializer: "heNormal",
    }));
    model.add(tf.layers.dropout({ rate: 0.3 }));

    model.add(tf.layers.dense({
        units: 1,
        activation: "sigmoid",
    }));

    model.compile({
        optimizer: tf.train.adam(0.001),
        loss: "binaryCrossentropy",
        metrics: ["accuracy"],
    });

    return model;
}

// ---------- Evaluation ----------

function confusionMatrix(yTrue, yPred, threshold = 0.5) {
    let tp = 0, fp = 0, tn = 0, fn = 0;
    for (let i = 0; i < yTrue.length; i++) {
        const actual = yTrue[i];
        const pred = yPred[i] >= threshold ? 1 : 0;
        if (actual === 1 && pred === 1) tp++;
        else if (actual === 0 && pred === 1) fp++;
        else if (actual === 0 && pred === 0) tn++;
        else fn++;
    }
    const total = tp + fp + tn + fn;
    const accuracy = total > 0 ? (tp + tn) / total : 0;
    const precision = (tp + fp) > 0 ? tp / (tp + fp) : 0;
    const recall = (tp + fn) > 0 ? tp / (tp + fn) : 0;
    const f1 = (precision + recall) > 0 ? 2 * precision * recall / (precision + recall) : 0;
    return { tp, fp, tn, fn, accuracy, precision, recall, f1 };
}

class LogCallback extends tf.Callback {
    async onEpochEnd(epoch, logs) {
        if (epoch % 5 === 0 || epoch < 3) {
            const acc = logs.acc ?? logs.accuracy ?? 0;
            const valAcc = logs.val_acc ?? logs.val_accuracy ?? 0;
            console.log(
                `  epoch ${String(epoch).padStart(3)} ` +
                `loss=${logs.loss.toFixed(4)} ` +
                `acc=${acc.toFixed(3)} ` +
                `val_loss=${logs.val_loss.toFixed(4)} ` +
                `val_acc=${valAcc.toFixed(3)}`
            );
        }
    }
}

// ---------- Main ----------

(async function main() {
    console.log("=".repeat(60));
    console.log("v5: Training denial-prediction NN");
    console.log("=".repeat(60));

    // 1. Load data
    const rows = await loadData();

    // Print class balance
    const denied = rows.filter(r => buildLabel(r) === 1).length;
    const orig = rows.length - denied;
    console.log(`Class balance: ${orig} originated / ${denied} denied (${(100 * denied / rows.length).toFixed(1)}% positive class)`);

    // 2. Stratified split
    const { train, test } = stratifiedSplit(rows, 0.2);
    console.log(`Split: ${train.length} train / ${test.length} test`);

    // 3. Build encoder from training data only (no peeking at test)
    const encoder = buildEncoder(train);
    console.log(`Encoder built: ${encoder.input_dim} input features`);
    for (const col of CATEGORICAL_FEATURES) {
        console.log(`  ${col}: ${encoder.categorical[col].length} categories`);
    }

    // 4. Encode tensors
    const xTrain = tf.tensor2d(train.map(r => encodeRow(r, encoder)));
    const yTrain = tf.tensor2d(train.map(r => [buildLabel(r)]));
    const xTest  = tf.tensor2d(test.map(r => encodeRow(r, encoder)));
    const yTest  = tf.tensor2d(test.map(r => [buildLabel(r)]));

    // 5. Build + train model with class weighting (denied is the minority class)
    const model = buildModel(encoder.input_dim);
    model.summary();

    const negWeight = 1.0;
    const posWeight = orig / Math.max(denied, 1); // upweight the minority class

    console.log(`\nTraining (class weights: orig=${negWeight.toFixed(2)}, denied=${posWeight.toFixed(2)})...`);

    const earlyStop = tf.callbacks.earlyStopping({
        monitor: "val_loss",
        patience: 8,
    });
    await model.fit(xTrain, yTrain, {
        epochs: 80,
        batchSize: 32,
        validationSplit: 0.15,
        classWeight: { 0: negWeight, 1: posWeight },
            callbacks: [
                earlyStop,
                new LogCallback(),
            ],
        verbose: 0,
    });

    // 6. Evaluate on held-out test set
    console.log("\nEvaluating on test set...");
    const yPredTensor = model.predict(xTest);
    const yPredArr = Array.from(await yPredTensor.data());
    const yTestArr = Array.from(await yTest.data());
    yPredTensor.dispose();

    const cm = confusionMatrix(yTestArr, yPredArr, 0.5);
    console.log("\nTest set confusion matrix (threshold = 0.5):");
    console.log(`              Predicted Originated   Predicted Denied`);
    console.log(`Actual Orig.  ${String(cm.tn).padStart(20)}   ${String(cm.fp).padStart(16)}`);
    console.log(`Actual Denied ${String(cm.fn).padStart(20)}   ${String(cm.tp).padStart(16)}`);
    console.log(`\nAccuracy:  ${(cm.accuracy * 100).toFixed(1)}%`);
    console.log(`Precision: ${(cm.precision * 100).toFixed(1)}%  (of predicted denials, how many really were)`);
    console.log(`Recall:    ${(cm.recall * 100).toFixed(1)}%  (of actual denials, how many we caught)`);
    console.log(`F1 score:  ${cm.f1.toFixed(3)}`);

    // 7. Save model + encoder
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    await model.save(`file://${OUTPUT_DIR}`);
    fs.writeFileSync(
        path.join(OUTPUT_DIR, "encoder.json"),
        JSON.stringify({
            ...encoder,
            numeric_features: NUMERIC_FEATURES,
            categorical_features: CATEGORICAL_FEATURES,
            test_metrics: cm,
            trained_at: new Date().toISOString(),
            train_rows: train.length,
            test_rows: test.length,
        }, null, 2)
    );

    console.log(`\nModel saved to ${OUTPUT_DIR}`);
    console.log("Done.");

    // Cleanup tensors
    xTrain.dispose(); yTrain.dispose();
    xTest.dispose(); yTest.dispose();
})().catch(err => {
    console.error("Training failed:", err);
    process.exit(1);
});
