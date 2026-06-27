export namespace main {
	
	export class NoteInfo {
	    path: string;
	    rel: string;
	    title: string;
	    fields: Record<string, string>;
	
	    static createFrom(source: any = {}) {
	        return new NoteInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.rel = source["rel"];
	        this.title = source["title"];
	        this.fields = source["fields"];
	    }
	}

}

export namespace ops {
	
	export class Condition {
	    kind: string;
	    key: string;
	    value: string;
	
	    static createFrom(source: any = {}) {
	        return new Condition(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.kind = source["kind"];
	        this.key = source["key"];
	        this.value = source["value"];
	    }
	}
	export class Op {
	    kind: string;
	    key: string;
	    value: string;
	    conds: Condition[];
	
	    static createFrom(source: any = {}) {
	        return new Op(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.kind = source["kind"];
	        this.key = source["key"];
	        this.value = source["value"];
	        this.conds = this.convertValues(source["conds"], Condition);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Verdict {
	    path: string;
	    status: string;
	    reason: string;
	    changes: string[];
	
	    static createFrom(source: any = {}) {
	        return new Verdict(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.status = source["status"];
	        this.reason = source["reason"];
	        this.changes = source["changes"];
	    }
	}

}

