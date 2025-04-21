const functions = require("firebase-functions/v1");
const admin = require("firebase-admin");
admin.initializeApp();

async function updatePatientStats(patientId, poseField, change) {
    if (!change.after.exists) return null;

    const poseData = change.after.data();
    const accuracy = poseData.accuracy;
    const timestamp = poseData.timestamp;

    if (accuracy === undefined || !timestamp) return null;

    const patientRef = admin.firestore().collection("patients").doc(patientId);
    const patientDoc = await patientRef.get();

    const avgField = `${poseField}_avg`;
    const countField = `count_${poseField}`;
    const timeField = `${poseField}_time`;

    let oldAvg = 0;
    let oldCount = 0;

    if (patientDoc.exists) {
        const data = patientDoc.data();
        oldAvg = data[avgField] || 0;
        oldCount = data[countField] || 0;
    }

    const newCount = oldCount + 1;
    const newAvg = ((oldAvg * oldCount) + accuracy) / newCount;
    const newTime = newCount * 3;

    await patientRef.update({
        [avgField]: newAvg,
        [countField]: newCount,
        [timeField]: newTime,
    });

    // ✅ Also update group-level stats here
    await updateAgeAndGenderGraphs(patientRef, poseField);

    return null;
}

for (let i = 1; i <= 5; i++) {
    const pose = `pose${i}`;
    exports[`aggregatePoseData_${pose}`] = functions.firestore
        .document(`patients/{patientId}/${pose}/{docId}`)
        .onWrite((change, context) => {
            const { patientId } = context.params;
            return updatePatientStats(patientId, pose, change);
        });
}

// ✅ New function that updates ageRangeGraph and genderGraph
async function updateAgeAndGenderGraphs(patientRef, poseField) {
    const db = admin.firestore();
    const patientSnap = await patientRef.get();
    const patient = patientSnap.data();

    const age = patient.age;
    const gender = (patient.gender || "").toLowerCase();
    const avgField = `${poseField}_avg`;

    if (!age || !gender || patient[avgField] === undefined) return;

    // Determine age group
    let ageGroup = "";
    if (age >= 40 && age <= 55) ageGroup = "youngOld";
    else if (age >= 56 && age <= 65) ageGroup = "middleOld";
    else if (age > 65) ageGroup = "veryOld";
    else return;

    const patientsSnap = await db.collection("patients").get();

    const filterPatients = (filterFn) =>
        patientsSnap.docs
            .map(doc => ({ id: doc.id, ...doc.data() }))
            .filter(filterFn)
            .map(p => p[avgField])
            .filter(val => val !== undefined);

    const ageValues = filterPatients(p =>
        (p.age >= 40 && p.age <= 55 && ageGroup === "youngOld") ||
        (p.age >= 56 && p.age <= 65 && ageGroup === "middleOld") ||
        (p.age > 65 && ageGroup === "veryOld")
    );

    const genderValues = filterPatients(p => (p.gender || "").toLowerCase() === gender);

    const calcAvg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

    await db.collection("ageRangeGraph").doc(ageGroup).set({
        [avgField]: calcAvg(ageValues),
    }, { merge: true });

    await db.collection("genderGraph").doc(gender).set({
        [avgField]: calcAvg(genderValues),
    }, { merge: true });
}
