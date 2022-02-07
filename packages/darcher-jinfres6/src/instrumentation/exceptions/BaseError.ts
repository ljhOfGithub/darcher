export default class BaseError extends Error {
    constructor(message?: string) { //message为可选
        super(message); // 'Error' breaks prototype chain here
        Object.setPrototypeOf(this, new.target.prototype); // restore prototype chain
    }
}