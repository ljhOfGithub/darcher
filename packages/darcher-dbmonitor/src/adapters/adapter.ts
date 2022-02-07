import {DBContent} from "@darcher/rpc";

export default interface Adapter { //Promise的泛型T代表promise变成成功态之后resolve的值
    connect(): Promise<Adapter>;

    close(): Promise<void>;

    getAllData(dbName: string): Promise<DBContent>;
}