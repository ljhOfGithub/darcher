import {DBContentDiffFilter} from "@darcher/analyzer";
import * as path from "path";
import {analyzeAll} from "./analyze";

const reportFile = "AgroChain.report.json";

// filter out off-chain state on the full snapshot of database
// 过滤掉数据库全快照的链下状态
const dbFilter: DBContentDiffFilter = {};

// ignore runtime errors with the following keywords
//忽略以下关键字的运行时错误
const runtimeErrorFilter :string[] = [
    "chrome-extension",
    "chromeextensionmm",
    "favicon.ico",
    "sentry.io",
    "infura.io"
];
// ico：区块链代币的ipo
const dataDir = path.join(__dirname, "..", "experiment-results", "AgroChain", "rounds");
const roundDirs = [
    path.join(dataDir, "AgroChain0", "transactions"),
    path.join(dataDir, "AgroChain1", "transactions"),
    path.join(dataDir, "AgroChain2", "transactions"),
    path.join(dataDir, "AgroChain3", "transactions"),
    path.join(dataDir, "AgroChain4", "transactions"),
    path.join(dataDir, "AgroChain5", "transactions"),
    path.join(dataDir, "AgroChain6", "transactions"),
    path.join(dataDir, "AgroChain7", "transactions"),
    path.join(dataDir, "AgroChain8", "transactions"),
    path.join(dataDir, "AgroChain9", "transactions"),
];

analyzeAll(roundDirs, dbFilter, runtimeErrorFilter, reportFile);
