export interface Service {
    start(): Promise<void>;

    shutdown(): Promise<void>;

    waitForEstablishment(): Promise<void>;
}
//服务收集器
export class ServiceCollector implements Service {
    private readonly services: Service[];

    constructor() {
        this.services = [];
    }

    public addService(...service: Service[]): ServiceCollector {
        this.services.push(...service);
        return this;
    }

    async start(): Promise<void> {
        // start services as their added order 根据添加服务的顺序开始服务，用promise控制顺序
        for (let s of this.services) {
            await s.start();
        }
    }

    async waitForEstablishment(): Promise<void> {
        // wait for services establishment from the last service 从最后一个服务等待建立
        for (let i = this.services.length - 1; i >= 0; i--) {
            await this.services[i].waitForEstablishment();
        }
    }

    async shutdown(): Promise<void> {
        // shutdown services  from the last service 从最后一个开始停止服务
        for (let i = this.services.length - 1; i >= 0; i--) {
            await this.services[i].shutdown();
        }
    }

}