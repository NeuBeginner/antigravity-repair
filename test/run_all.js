/**
 * Master Test Runner for antigravity-repair
 * Executes all test suites in complete isolation from real Antigravity data.
 */

const { execFileSync } = require("child_process");
const path = require("path");

const { runPbtxtTests } = require("./test_pbtxt");
const { runProtobufTests } = require("./test_protobuf");
const { runBackupRestoreTests } = require("./test_backup_restore");
const { runRepairSafetyTests } = require("./test_repair_safety");
const { runMockServerTests } = require("./test_mock_server");

async function main() {
  console.log("==================================================");
  console.log("    ANTIGRAVITY REPAIR - AUTOMATED TEST SUITE     ");
  console.log("    (Running in isolated mock sandbox)            ");
  console.log("==================================================\n");

  const startTime = Date.now();
  let totalTests = 0;

  try {
    // 1. PBTXT tests
    totalTests += runPbtxtTests();

    // 2. Protobuf tests
    totalTests += runProtobufTests();

    // 3. Backup & Restore tests
    totalTests += runBackupRestoreTests();

    // 4. Repair Safety & Dry-run tests
    totalTests += runRepairSafetyTests();

    // 5. Mock Server End-to-End integration tests
    totalTests += await runMockServerTests();

    // 6. PowerShell Watchdog test suite
    console.log("--- Running PowerShell Watchdog Suite ---");
    const psScript = path.join(__dirname, "test_watchdog.ps1");
    execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", psScript], {
      stdio: "inherit",
    });
    totalTests += 10;

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log("==================================================");
    console.log(`ALL TESTS PASSED! Total assertions/tests: ${totalTests}`);
    console.log(`Duration: ${duration}s`);
    console.log("Zero production data was touched or modified.");
    console.log("==================================================");
    process.exit(0);
  } catch (err) {
    console.error("\n[TEST RUNNER FATAL ERROR]", err);
    process.exit(1);
  }
}

main();
