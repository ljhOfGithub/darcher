import {
    ConsoleErrorMsg,
    ContractVulReport, DBContent,
    TestEndMsg,
    TestStartMsg,
    TxErrorMsg,
    TxFinishedMsg,
    TxMsg,
    TxState,
    TxStateChangeMsg,
    TxStateControlMsg,
    TxTraverseStartMsg
} from "@darcher/rpc";
import {EventEmitter} from "events";
import {$enum} from "ts-enum-util";
import {Config, DBOptions} from "@darcher/config";
import {Logger, prettifyHash, sleep} from "@darcher/helpers";
import {DbMonitorService} from "./service/dbmonitorService";
import {Oracle, Report} from "./oracle";

/**
 * Extend TxState to introduce logical tx state (removed, re-executed)
 * 扩展TxState来引入逻辑的tx状态(删除，重新执行)，枚举交易的类型
 */
export enum LogicalTxState {
    CREATED,
    PENDING,
    EXECUTED,
    DROPPED,
    CONFIRMED,
    REMOVED,
    REEXECUTED,
}

export const allLogicalTxStates = [
    LogicalTxState.CREATED,
    LogicalTxState.PENDING,
    LogicalTxState.EXECUTED,
    LogicalTxState.DROPPED,
    LogicalTxState.CONFIRMED,
    LogicalTxState.REMOVED,
    LogicalTxState.REEXECUTED,
]

export function isEqualState(s: TxState, ls: LogicalTxState): boolean {
    if (<number>s === <number>ls) {
        return true;
    }
    return s === TxState.EXECUTED && ls === LogicalTxState.REEXECUTED ||
        s === TxState.PENDING && ls === LogicalTxState.REMOVED;
}
// LogicalTxState转换为TxState
export function toTxState(ls: LogicalTxState): TxState {
    switch (ls) {
        case LogicalTxState.CONFIRMED:
            return TxState.CONFIRMED;
        case LogicalTxState.CREATED:
            return TxState.CREATED;
        case LogicalTxState.DROPPED:
            return TxState.DROPPED;
        case LogicalTxState.EXECUTED:
            return TxState.EXECUTED;
        case LogicalTxState.PENDING:
            return TxState.PENDING;
        case LogicalTxState.REEXECUTED:
            return TxState.EXECUTED;
        case LogicalTxState.REMOVED:
            return TxState.PENDING;
    }
}

/**
 * Analyzer is for each tx, it controls the tx state via grpc with ethmonitor and collect dapp state change data, to generate analyze report
 *分析器是为每个交易，它通过grpc与ethmonitor控制tx的状态，并收集dapp状态变化数据，生成分析报告
 */
export class Analyzer {
    public dappStateUpdateTimeLimit = 15000;

    private readonly config: Config;
    private readonly logger: Logger;
    public readonly txHash: string;
    private txState: LogicalTxState;
    public readonly parentHash: string;

    private _finished: boolean;

    /**
     * A log used for offline analysis
     * 用于离线分析的日志
     */
    public readonly log: TransactionLog;

    dbMonitorService: DbMonitorService;

    private stateChangeWaiting: Promise<LogicalTxState>;
    private stateEmitter: EventEmitter;

    // use for analysis
    //用于分析
    oracles: Oracle[] = [];
    // txError cache, will be cleaned when forwarded to oracles
    // 交易错误缓存，当转发到oracle时会被清理
    txErrors: TxErrorMsg[] = [];
    // contractVulnerability cache, will be cleaned when forwarded to oracles
    // 合同漏洞缓存，将被清除时转发到oracle
    contractVulReports: ContractVulReport[] = [];
    // consoleError cache, will be cleaned when forwarded to oracles
    // 控制台错误缓存，将被清除时转发到oracle
    consoleErrors: ConsoleErrorMsg[] = [];

    constructor(logger: Logger, config: Config, txHash: string, dbmonitorService: DbMonitorService, parentHash: string = null) {
        this.config = config;
        this.logger = logger;
        this.txHash = txHash;
        this._finished = false;
        this.parentHash = parentHash;
        this.dappStateUpdateTimeLimit = config.analyzer.txStateChangeProcessTime ? config.analyzer.txStateChangeProcessTime : 15000;
        this.dbMonitorService = dbmonitorService;
        this.txState = LogicalTxState.CREATED;
        this.stateEmitter = new EventEmitter();
        this.stateChangeWaiting = new Promise<LogicalTxState>(resolve => {
            this.stateEmitter.once($enum(LogicalTxState).getKeyOrThrow(LogicalTxState.CREATED), resolve)
        });
        this.log = <TransactionLog>{
            parent: parentHash,
            hash: txHash,
            states: {
                [LogicalTxState.CREATED]: null,
                [LogicalTxState.PENDING]: null,
                [LogicalTxState.EXECUTED]: null,
                [LogicalTxState.REMOVED]: null,
                [LogicalTxState.REEXECUTED]: null,
                [LogicalTxState.CONFIRMED]: null,
                [LogicalTxState.DROPPED]: null,
            }
        }
    }

    /* darcher controller handlers start */
    public async onTxStateChange(msg: TxStateChangeMsg): Promise<void> {
        if (msg.getFrom() === TxState.EXECUTED &&
            msg.getTo() === TxState.PENDING &&
            this.txState === LogicalTxState.EXECUTED) {
            // remove
            this.txState = LogicalTxState.REMOVED;
        } else if (this.txState === LogicalTxState.REMOVED &&
            msg.getFrom() === TxState.PENDING &&
            msg.getTo() === TxState.EXECUTED) {
            // re-execute
            this.txState = LogicalTxState.REEXECUTED;
        } else if (!isEqualState(msg.getFrom(), this.txState)) {
            this.logger.warn("Tx state inconsistent,",
                {
                    "expect": $enum(LogicalTxState).getKeyOrThrow(this.txState),
                    "got": $enum(TxState).getKeyOrThrow(msg.getFrom())
                }
            );
            this.txState = <LogicalTxState>(msg.getTo() as number);
        } else {
            this.txState = <LogicalTxState>(msg.getTo() as number);
        }
        // apply oracles, this may block for a while
        if (this.txState === LogicalTxState.PENDING) {
            await sleep(2000);
        }
        await this.applyOracles(this.txState);
        this.stateEmitter.emit($enum(LogicalTxState).getKeyOrThrow(this.txState), this.txState);
        if (this.txState === LogicalTxState.CONFIRMED || this.txState === LogicalTxState.DROPPED) {
            this._finished = true;
        }
    }

    public async onTxTraverseStart(msg: TxTraverseStartMsg): Promise<void> {
        // fire the TxStateChange event on CREATED state, this is a fake event just used to apply oracles on CREATED state
        // 在create状态触发TxStateChange事件，这是一个假事件，只用于在create状态应用oracle
        await this.onTxStateChange(new TxStateChangeMsg().setHash(this.txHash).setFrom(undefined).setTo(TxState.CREATED));
    }

    public async onTxFinished(msg: TxFinishedMsg): Promise<void> {
        // wait for tx state changed to CONFIRMED
        // 等待tx状态更改为确定
        await this.stateChangeWaiting;
    }

    public async askForNextState(msg: TxStateControlMsg): Promise<TxState> {
        // before tell ethmonitor next state, make sure previous state has been reached
        // 在告诉ethmonitor下一个状态之前，确保已经到达前一个状态
        await this.stateChangeWaiting;
        if (this.txState === LogicalTxState.CREATED) {
            this.stateChangeWaiting = new Promise<LogicalTxState>(resolve => {
                this.stateEmitter.once($enum(LogicalTxState).getKeyOrThrow(LogicalTxState.PENDING), resolve)
            });
            return TxState.PENDING;
        } else if (this.txState === LogicalTxState.PENDING) {
            this.stateChangeWaiting = new Promise<LogicalTxState>(resolve => {
                this.stateEmitter.once($enum(LogicalTxState).getKeyOrThrow(LogicalTxState.EXECUTED), resolve)
            });
            return TxState.EXECUTED;
        } else if (this.txState === LogicalTxState.EXECUTED) {
            this.stateChangeWaiting = new Promise<LogicalTxState>(resolve => {
                this.stateEmitter.once($enum(LogicalTxState).getKeyOrThrow(LogicalTxState.REMOVED), resolve)
            });
            return TxState.PENDING;
        } else if (this.txState === LogicalTxState.REMOVED) {
            this.stateChangeWaiting = new Promise<LogicalTxState>(resolve => {
                this.stateEmitter.once($enum(LogicalTxState).getKeyOrThrow(LogicalTxState.REEXECUTED), resolve)
            });
            return TxState.EXECUTED;
        } else if (this.txState === LogicalTxState.REEXECUTED) {
            this.stateChangeWaiting = new Promise<LogicalTxState>(resolve => {
                this.stateEmitter.once($enum(LogicalTxState).getKeyOrThrow(LogicalTxState.CONFIRMED), resolve)
            });
            return TxState.CONFIRMED
        } else if (this.txState === LogicalTxState.CONFIRMED) {
            this.stateChangeWaiting = Promise.resolve(LogicalTxState.CONFIRMED);
            return TxState.CONFIRMED;
        } else if (this.txState === LogicalTxState.DROPPED) {
            this.stateChangeWaiting = Promise.resolve(LogicalTxState.DROPPED);
            return TxState.DROPPED;
        }
    }

    public async onTxError(msg: TxErrorMsg): Promise<void> {
        this.txErrors.push(msg);
    }

    public async onContractVulnerability(msg: ContractVulReport): Promise<void> {
        this.contractVulReports.push(msg);
    }

    /* darcher controller handlers end */

    /* dappTestDriverService handlers start */
    /* darcher controller handler结束*/

    /* dappTestDriverService处理程序启动*/
    public async onTestStart(msg: TestStartMsg): Promise<void> {

    }

    public async onTestEnd(msg: TestEndMsg): Promise<void> {

    }

    public async onConsoleError(msg: ConsoleErrorMsg): Promise<void> {
        this.consoleErrors.push(msg);
    }

    /**
     * This method will be called through grpc by dapp test driver and will cause dapp test driver pause.
     *
     * This method will wait until the whole tx lifecycle traverse is finished and then resolve the promise.
     * 此方法将通过grpc被dapp测试驱动程序调用，并将导致dapp测试驱动程序暂停。
     * 该方法将等待整个tx生命周期的遍历完成，然后解决承诺。
     * @param msg
     */
    public async waitForTxProcess(msg: TxMsg): Promise<void> {
        return new Promise<void>(resolve => {
            if (this.finished) {
                resolve();
            }
            // only resolve the promise when stateEmitter has emitted LogicalTxState.CONFIRMED
            // at this time tx lifecycle traverse should finished
            //只有当stateEmitter已经发出LogicalTxState.CONFIRMED时才解析promise
            //此时tx生命周期的遍历将结束
            this.stateEmitter.once($enum(LogicalTxState).getKeyOrThrow(LogicalTxState.CONFIRMED), () => resolve());
            this.stateEmitter.once($enum(LogicalTxState).getKeyOrThrow(LogicalTxState.DROPPED), () => resolve());
        });
    }

    /* dappTestDriverService handlers end */


    /**
     * Call each oracle's onTxState method, forwarding current txState, dbContent, txErrors, contractVulReports and consoleErrors
     * to each oracle and clean txErrors, contractVulReports, consoleErrors
     *
     * This method will first wait for a time limit for dapp to handle transaction state change.
     * *调用每个oracle的ontxstate方法，转发当前的txState, dbContent, txErrors, contractVulReports和consoleErrors
     * 清理txErrors, contractVulReports, consoleErrors
     * 该方法将首先等待dapp处理事务状态变化的时间限制。
     * @param txState The state that transaction is at currently事务当前的状态
     */
    private async applyOracles(txState: LogicalTxState): Promise<void> {
        this.logger.debug("Apply oracle on transaction", {
            tx: prettifyHash(this.txHash),
            "state": $enum(LogicalTxState).getKeyOrDefault(txState, undefined)
        });
        // the time limit (milliseconds) for dapp to handle tx state change 
        // dapp处理tx状态变化的时间限制(毫秒
        return new Promise(async resolve => {
            let waitTime;
            if (this.txState === LogicalTxState.CREATED) {
                waitTime = 500;
            } else {
                waitTime = this.dappStateUpdateTimeLimit;
                if (this.config.dbMonitor.dbName !== "html") {
                    // only refresh page when db is not html
                    try {
                        this.logger.debug("Refreshing page...");
                        await this.dbMonitorService.refreshPage(this.config.dbMonitor.dbAddress);
                    } catch (e) {
                        this.logger.error(e);
                    }
                }
            }
            setTimeout(async () => {
                // call dbMonitor service to get dbContent
                try {
                    let data = undefined;
                    if (this.config.dbMonitor.db === DBOptions.html) {
                        if (this.config.dbMonitor.js) {
                            data = this.config.dbMonitor.js;
                        } else if (this.config.dbMonitor.elements) {
                            data = JSON.stringify(this.config.dbMonitor.elements);
                        }
                    }
                    let dbContent = await this.dbMonitorService.getAllData(this.config.dbMonitor.dbAddress, this.config.dbMonitor.dbName, data);
                    this.logger.debug("GetAllData", {
                        "state": $enum(LogicalTxState).getKeyOrDefault(txState, undefined),
                        "data": dbContent.toObject()
                    });
                    // forward to each oracle
                    for (let oracle of this.oracles) {
                        oracle.onTxState(txState, dbContent, this.txErrors, this.contractVulReports, this.consoleErrors);
                    }
                    this.log.states[txState] = {
                        dbContent: dbContent.toObject(),
                        txErrors: this.txErrors.map(item => item.toObject()),
                        consoleErrors: this.consoleErrors.map(item => item.toObject()),
                        contractVulReports: this.contractVulReports.map(item => item.toObject()),
                    };
                } catch (e) {
                    this.logger.error(e);
                }
                // clean txErrors, contractVulReports, consoleErrors, because they are cache for only one tx state
                this.txErrors = [];
                this.contractVulReports = [];
                this.consoleErrors = [];

                resolve();
            }, waitTime);
        })
    }

    /**
     * Get bug reports of all oracles, if there is no bug, an empty array will be returned
     * 获取所有oracle的bug报告，如果没有bug，将返回一个空数组
     */
    public getBugReports(): Report[] {
        let reports: Report[] = [];
        for (let oracle of this.oracles) {
            reports.push(...oracle.getBugReports());
        }
        return reports;
    }

    get finished(): boolean {
        return this._finished;
    }
}

/**
 * This class records database changes in each state of transaction
 * 这个类记录事务的每个状态下数据库的变化
 */
export interface TransactionLog {
    parent: string | null,
    hash: string,
    states: {
        [LogicalTxState.CREATED]: TransactionStateLog | null,
        [LogicalTxState.PENDING]: TransactionStateLog | null,
        [LogicalTxState.EXECUTED]: TransactionStateLog | null,
        [LogicalTxState.REMOVED]: TransactionStateLog | null,
        [LogicalTxState.REEXECUTED]: TransactionStateLog | null,
        [LogicalTxState.CONFIRMED]: TransactionStateLog | null,
        [LogicalTxState.DROPPED]: TransactionStateLog | null,
    },
    stack?: string[],
}

export interface TransactionStateLog {
    dbContent: DBContent.AsObject,
    txErrors: TxErrorMsg.AsObject[],
    consoleErrors: ConsoleErrorMsg.AsObject[],
    contractVulReports: ContractVulReport.AsObject[],
}
