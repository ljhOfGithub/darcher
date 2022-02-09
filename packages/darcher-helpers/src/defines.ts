import * as path from "path";
//设置路径，每一个参数是/ /间的路径，../../darcher-go-ethereum，_dirname表示当前目录，即/src，没有构建，文件夹是空的 
export const ETHMONITOR_PATH = path.join(__dirname, "..", "..", "darcher-go-ethereum", "build", "bin", "ethmonitor");
export const GETH_PATH = path.join(__dirname, "..", "..", "darcher-go-ethereum", "build", "bin", "geth");
export const EVM_PATH = path.join(__dirname, "..", "..", "darcher-go-ethereum", "build", "bin", "evm");
