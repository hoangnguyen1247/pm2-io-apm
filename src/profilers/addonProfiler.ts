import { ProfilerType } from '../features/profiling'
import utils from '../utils/module'
import Configuration from '../configuration'
import { ServiceManager } from '../serviceManager'
import { Transport } from '../services/transport'
import ActionService from '../services/actions'
import MiscUtils from '../utils/miscellaneous'
import * as Debug from 'debug'

class CurrentProfile {
  uuid: string
  startTime: number
  initiated: string
}

export default class AddonProfiler implements ProfilerType {

  private profiler: any = null
  /**
   * List of modules that we can require as profiler
   * the v8-profiler module has segfault for node > 8
   * so we want to be able to use the newer one in priority
   */
  private modules = [ 'v8-profiler-node8', 'v8-profiler' ]
  private actionService: ActionService | undefined
  private transport: Transport | undefined
  private currentProfile: CurrentProfile | null = null
  private logger: Function = Debug('axm:features:profiling:addon')

  init () {
    for (const moduleName of this.modules) {
      let path = utils.detectModule(moduleName)
      // continue to search if we dont find it
      if (path === null) continue
      let profiler = utils.loadModule(moduleName)
      // we can fail to require it for some reasons
      if (profiler instanceof Error) continue
      this.profiler = profiler
      break
    }
    if (this.profiler === null) {
      Configuration.configureModule({
        heapdump: false,
        'feature.profiler.heap_snapshot': false,
        'feature.profiler.heap_sampling': false,
        'feature.profiler.cpu_js': false
      })
      return console.error(`Failed to require the profiler via addon, disabling profiling ...`)
    }

    this.actionService = ServiceManager.get('actions')
    if (this.actionService === undefined) {
      return this.logger(`Fail to get action service`)
    }
    this.transport = ServiceManager.get('transport')
    if (this.transport === undefined) {
      return this.logger(`Fail to get transport service`)
    }

    Configuration.configureModule({
      heapdump: true,
      'feature.profiler.heapsnapshot': true,
      'feature.profiler.heapsampling': true,
      'feature.profiler.cpu_js': true
    })
    this.register()
  }

  register () {
    if (this.actionService === undefined) {
      return this.logger(`Fail to get action service`)
    }
    this.actionService.registerAction('km:heapdump', this.onHeapdump)
    this.actionService.registerAction('km:cpu:profiling:start', this.onCPUProfileStart)
    this.actionService.registerAction('km:cpu:profiling:stop', this.onCPUProfileStop)
    this.actionService.registerAction('km:heap:profiling:start', this.onHeapProfileStart)
    this.actionService.registerAction('km:heap:profiling:stop', this.onHeapProfileStop)
  }

  destroy () {
    this.logger('Addon Profiler destroyed !')
    if (this.profiler === null) return
    this.profiler.deleteAllProfiles()
  }

  private onHeapProfileStart (opts, cb) {
    if (typeof cb !== 'function') {
      cb = opts
      opts = {}
    }
    if (typeof opts !== 'object') {
      opts = {}
    }

    if (this.currentProfile !== null) {
      return cb({
        err: new Error('A profiling is already running'),
        success: false
      })
    }
    this.currentProfile = new CurrentProfile()
    this.currentProfile.uuid = MiscUtils.generateUUID()
    this.currentProfile.startTime = Date.now()
    this.currentProfile.initiated = typeof opts.initiated === 'string'
      ? opts.initiated : 'manual'

     // run the callback to acknowledge that we received the action
    cb({ success: true, uuid: this.currentProfile })

    this.profiler.startTrackingHeapObjects()
    
    if (isNaN(parseInt(opts.timeout))) return
    // if the duration is included, handle that ourselves
    const duration = parseInt(opts.timeout)
    setTimeout(_ => {
      // it will send the profiling itself
      this.onHeapProfileStop(_ => {})
    }, duration)
  }

  private onHeapProfileStop (cb) {
    if (this.currentProfile === null) {
      return cb({
        err: new Error('No profiling are already running'),
        success: false
      })
    }
    this.profiler.stopTrackingHeapObjects()

    // run the callback to acknowledge that we received the action
    cb({ success: true })

    const buffer: Array<string> = []
    this.profiler.getHeapStats((data: string) => buffer.push(data), () => {
      // not possible but thanks mr typescript
      if (this.currentProfile === null) return
      if (this.transport === undefined) return
      const data = buffer.join('')
      // send the profile to the transporter
      this.transport.send('profilings', {
        uuid: this.currentProfile.uuid,
        duration: Date.now() - this.currentProfile.startTime,
        at: this.currentProfile.startTime,
        dump_file_size: data.length,
        data,
        success: true,
        initiated: this.currentProfile.initiated,
        type: 'heapprofile',
        heapprofile: true
      })
      this.currentProfile = null
    })
  }

  private onCPUProfileStart (opts, cb) {
    if (typeof cb !== 'function') {
      cb = opts
      opts = {}
    }
    if (typeof opts !== 'object') {
      opts = {}
    }

    if (this.currentProfile !== null) {
      return cb({
        err: new Error('A profiling is already running'),
        success: false
      })
    }
    this.currentProfile = new CurrentProfile()
    this.currentProfile.uuid = MiscUtils.generateUUID()
    this.currentProfile.startTime = Date.now()
    this.currentProfile.initiated = typeof opts.initiated === 'string'
      ? opts.initiated : 'manual'

     // run the callback to acknowledge that we received the action
    cb({ success: true, uuid: this.currentProfile })

    this.profiler.startProfiling()
    
    if (isNaN(parseInt(opts.timeout))) return
    // if the duration is included, handle that ourselves
    const duration = parseInt(opts.timeout)
    setTimeout(_ => {
      // it will send the profiling itself
      this.onCPUProfileStop(_ => {})
    }, duration)
  }

  private onCPUProfileStop (cb) {
    if (this.currentProfile === null) {
      return cb({
        err: new Error('No profiling are already running'),
        success: false
      })
    }
    if (this.transport === undefined) {
      return cb({
        err: new Error('No profiling are already running'),
        success: false
      })
    }
    const profile = this.profiler.stopProfiling()
    const data = JSON.stringify(profile)

    // run the callback to acknowledge that we received the action
    cb({ success: true })

    // send the profile to the transporter
    this.transport.send('profilings', {
      uuid: this.currentProfile.uuid,
      duration: Date.now() - this.currentProfile.startTime,
      at: this.currentProfile.startTime,
      data,
      dump_file_size: data.length,
      success: true,
      initiated: this.currentProfile.initiated,
      type: 'cpuprofile',
      cpuprofile: true
    })
    this.currentProfile = null
  }

  /**
   * Custom action implementation to make a heap snapshot
   */
  private onHeapdump (opts, cb) {
    if (typeof cb !== 'function') {
      cb = opts
      opts = {}
    }
    if (typeof opts !== 'object') {
      opts = {}
    }

    // run the callback to acknowledge that we received the action
    cb({ success: true })

    // wait few ms to be sure we sended the ACK because the snapshot stop the world
    setTimeout(() => {
      const startTime = Date.now()
      this.takeSnapshot()
        .then((data: string) => {
          // @ts-ignore thanks mr typescript but its not possible
          return this.transport.send('profilings', {
            data,
            at: startTime,
            initiated: typeof opts.initiated === 'string' ? opts.initiated : 'manual',
            duration: Date.now() - startTime,
            type: 'heapdump'
          })
        }).catch(err => {
          return cb({
            success: false,
            err: err
          })
        })
    }, 200)
  }

  private takeSnapshot () {
    return new Promise((resolve, reject) => {
      const snapshot = this.profiler.takeSnapshot();
      snapshot.export((err, data) => {
        if (err) {
          reject(err)
        } else {
          resolve(data)
        }
        // delete the snapshot as soon as we have serialized it
        snapshot.delete()
      })
    })
  }
}
