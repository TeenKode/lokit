/** Undo/redo state independent of DOM. Stores data only, never File objects. */
export function createEditHistory(initial,{limit=80,mergeWindow=300,clock=()=>Date.now()}={}){
  const copy=value=>JSON.parse(JSON.stringify(value));
  let states=[copy(initial)],index=0,lastKey='',lastTime=-Infinity;
  const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  function record(value,{mergeKey=''}={}){
    if(same(states[index],value))return false;
    const now=clock();
    const merge=mergeKey&&mergeKey===lastKey&&now-lastTime<=mergeWindow&&index===states.length-1&&index>0;
    if(merge){states[index]=copy(value);}
    else{
      states=states.slice(0,index+1);
      states.push(copy(value));
      if(states.length>limit+1)states.shift();
      index=states.length-1;
    }
    lastKey=mergeKey;lastTime=now;
    return true;
  }
  return {
    record,
    undo(){if(index===0)return null;index--;lastKey='';return copy(states[index]);},
    redo(){if(index===states.length-1)return null;index++;lastKey='';return copy(states[index]);},
    reset(value){states=[copy(value)];index=0;lastKey='';lastTime=-Infinity;},
    get canUndo(){return index>0;},
    get canRedo(){return index<states.length-1;},
    get current(){return copy(states[index]);}
  };
}
