//
//  TarGzExtractor.swift
//  Coomi
//
//  纯 Swift 的 .tar.gz 解包器。
//
//  ============ 为什么要自己写 ============
//
//  iOS 不允许 fork/exec 外部进程，所以调不到 /usr/bin/tar。
//  而 iSH 的 fakefs 镜像必须在**宿主侧**解开（boot 之前）——
//  见 ISHBridge.prepareFakefs 的注释：先有 meta.db 才能 boot，
//  boot 之前又没有 guest 的 /bin/tar 可用，是个死结。
//  所以只能自己解。
//
//  ============ 支持范围 ============
//
//  fakefs 镜像的实际内容（实测 3192 条目）：
//    · 普通文件（type 0）—— 大部分
//    · 目录（type 5）
//    · 符号链接（type 2）—— /bin/sh → busybox 等
//    · 硬链接（type 1）—— 少量
//    · PAX 扩展头（type x/g）—— macOS 打包带进来的，跳过
//    · AppleDouble（._xxx）—— 跳过，那是 macOS 的元数据垃圾
//  只需要这几种就能完整还原。
//
//  ============ 注意 ============
//
//  tar 的 size 字段是**八进制**字符串，不是十进制。
//  条目数据按 512 字节对齐，所以偏移量要向上取整到 512 的倍数。
//  这两点写错会导致解出来的文件全错位。
//

import Foundation
import Compression

enum TarGzError: LocalizedError {
    case notGzip
    case inflateFailed(String)
    case badTarHeader(offset: Int)
    case unsupportedEntryType(String)
    case writeFailed(String, String)

    var errorDescription: String? {
        switch self {
        case .notGzip:
            return "不是 gzip 文件（缺少 0x1f 0x8b 魔数）"
        case .inflateFailed(let s):
            return "gzip 解压失败：\(s)"
        case .badTarHeader(let off):
            return "tar 头解析失败（偏移 \(off)）"
        case .unsupportedEntryType(let t):
            return "不支持的 tar 条目类型：\(t)"
        case .writeFailed(let name, let why):
            return "写入 \(name) 失败：\(why)"
        }
    }
}

struct TarGzExtractor {
    /// 解包 .tar.gz 到 dest。已存在的东西会被覆盖。
    ///
    /// - Returns: 解出的条目数。
    @discardableResult
    static func extract(fileAt archive: URL, into dest: URL) throws -> Int {
        let raw = try Data(contentsOf: archive)
        let tar = try gunzip(raw)

        let fm = FileManager.default
        try fm.createDirectory(at: dest, withIntermediateDirectories: true)

        var off = 0
        var count = 0
        // 硬链接延后处理：目标可能还没解出来。
        var pendingHardlinks: [(link: String, target: String)] = []

        while off + 512 <= tar.count {
            // 全零块 = 归档结束
            if tar[off..<(off + 512)].allSatisfy({ $0 == 0 }) { break }

            let header = tar.subdata(in: off..<(off + 512))
            guard let name = TarGzExtractor.string(header, 0, 100) else {
                throw TarGzError.badTarHeader(offset: off)
            }
            // size 是八进制
            let sizeStr = TarGzExtractor.string(header, 124, 12)?
                .trimmingCharacters(in: CharacterSet(charactersIn: " \0")) ?? "0"
            let size = Int(sizeStr, radix: 8) ?? 0
            let type = header[156]
            let linkName = TarGzExtractor.string(header, 157, 100) ?? ""
            // 大文件用 prefix 字段拼路径（ustar）
            let prefix = TarGzExtractor.string(header, 345, 155) ?? ""
            let fullName = prefix.isEmpty ? name : "\(prefix)/\(name)"

            let dataStart = off + 512
            let dataEnd = min(dataStart + size, tar.count)

            // 跳过 macOS 的 AppleDouble 垃圾与 PAX 扩展头。
            //
            // 实测 fs.tar.gz：1920 个普通文件条目里，1064 个是 `._xxx`
            // （AppleDouble，macOS 打包时塞进来的 xattr 副本，各 163 字节），
            // 真实的只有 856 个。同时另有 1064 个 PAX 头，数量一一对应。
            // 所以「过滤掉 1064」不是丢文件，是本来就该丢。
            let base = (fullName as NSString).lastPathComponent
            let isJunk = base.hasPrefix("._") || base.hasPrefix("PaxHeader/")
                         || fullName.contains("/PaxHeader/")
            // x/g 是 PAX 扩展头，内容只有 mtime/xattr，不是文件本身
            let isPax = type == UInt8(ascii: "x") || type == UInt8(ascii: "g")

            if !isJunk && !isPax {
                let target = dest.appendingPathComponent(fullName)
                // 关键：普通文件的 type 字节是 ASCII '0'（0x30 = 48），不是 0。
                //
                // 这里踩过坑：原先写 `case 0, 0x00`，1920 个文件全部不匹配，
                // 结果只解出目录树、一个文件都没有，而 extract() 照样返回成功。
                // 所以下面同时接受 '0'(48) 和 0（有些简化 tar 真用 0）。
                switch type {
                case UInt8(ascii: "0"), 0:
                    if fullName.hasSuffix("/") {
                        // 有些 tar 用 type '0' + 尾斜杠表示目录
                        try fm.createDirectory(at: target, withIntermediateDirectories: true)
                    } else {
                        try fm.createDirectory(at: target.deletingLastPathComponent(),
                                               withIntermediateDirectories: true)
                        try? fm.removeItem(at: target)
                        let payload = tar.subdata(in: dataStart..<dataEnd)
                        do {
                            try payload.write(to: target)
                        } catch {
                            throw TarGzError.writeFailed(fullName, error.localizedDescription)
                        }
                    }
                    count += 1

                case UInt8(ascii: "5"):
                    try fm.createDirectory(at: target, withIntermediateDirectories: true)
                    count += 1

                case UInt8(ascii: "2"): // 符号链接
                    try fm.createDirectory(at: target.deletingLastPathComponent(),
                                           withIntermediateDirectories: true)
                    try? fm.removeItem(at: target)
                    do {
                        try fm.createSymbolicLink(atPath: target.path,
                                                  withDestinationPath: linkName)
                    } catch {
                        throw TarGzError.writeFailed(fullName, error.localizedDescription)
                    }
                    count += 1

                case UInt8(ascii: "1"): // 硬链接，延后
                    pendingHardlinks.append((link: fullName, target: linkName))
                    count += 1

                default:
                    // 其它类型（设备节点、FIFO）在 iOS 沙箱里无意义，跳过。
                    break
                }
            }

            // 数据区按 512 对齐
            let padded = ((size + 511) / 512) * 512
            off = dataStart + padded
        }

        // 补硬链接
        for (link, linkTarget) in pendingHardlinks {
            let src = dest.appendingPathComponent(linkTarget)
            let dst = dest.appendingPathComponent(link)
            try? fm.removeItem(at: dst)
            try fm.createDirectory(at: dst.deletingLastPathComponent(),
                                   withIntermediateDirectories: true)
            if fm.fileExists(atPath: src.path) {
                try? fm.linkItem(at: src, to: dst)
            }
        }

        return count
    }

    /// 读 tar 头里的定长字符串字段，去掉结尾的 NUL。
    private static func string(_ header: Data, _ start: Int, _ len: Int) -> String? {
        guard start + len <= header.count else { return nil }
        let slice = header.subdata(in: start..<(start + len))
        guard let nul = slice.firstIndex(of: 0) else {
            return String(data: slice, encoding: .utf8)
        }
        return String(data: slice[slice.startIndex..<nul], encoding: .utf8)
    }

    // MARK: - gzip

    /// 解 gzip。iOS 的 Compression framework 只做 deflate 裸流，
    /// 所以这里先剥掉 gzip 头（10 字节 + 可选字段），再解 deflate。
    static func gunzip(_ data: Data) throws -> Data {
        guard data.count > 18, data[0] == 0x1f, data[1] == 0x8b else {
            throw TarGzError.notGzip
        }
        // 第 3 字节最低位 FEXTRA 表示有扩展字段
        let flags = data[3]
        var p = 10
        if flags & 0x04 != 0 { // FEXTRA
            guard p + 2 <= data.count else { throw TarGzError.inflateFailed("头截断") }
            let xlen = Int(data[p]) | (Int(data[p + 1]) << 8)
            p += 2 + xlen
        }
        if flags & 0x08 != 0 { // FNAME
            while p < data.count && data[p] != 0 { p += 1 }
            p += 1
        }
        if flags & 0x10 != 0 { // FCOMMENT
            while p < data.count && data[p] != 0 { p += 1 }
            p += 1
        }
        if flags & 0x02 != 0 { p += 2 } // FHCRC

        guard p < data.count else { throw TarGzError.inflateFailed("头之后没有数据") }
        // 去掉 gzip 尾部 8 字节（CRC32 + ISIZE）
        let bodyEnd = max(p, data.count - 8)
        let body = data.subdata(in: p..<bodyEnd)

        // 分块流式解压，避免一次申请过大缓冲。
        let chunk = 1 << 20 // 1MB 输出缓冲
        var out = Data()
        let dst = UnsafeMutablePointer<UInt8>.allocate(capacity: chunk)
        defer { dst.deallocate() }

        try body.withUnsafeBytes { (srcRaw: UnsafeRawBufferPointer) in
            guard let srcBase = srcRaw.bindMemory(to: UInt8.self).baseAddress else {
                throw TarGzError.inflateFailed("空输入")
            }
            let stream = UnsafeMutablePointer<compression_stream>.allocate(capacity: 1)
            defer { stream.deallocate() }
            var status = compression_stream_init(stream, COMPRESSION_STREAM_DECODE, COMPRESSION_ZLIB)
            guard status == COMPRESSION_STATUS_OK else {
                throw TarGzError.inflateFailed("stream_init 失败 \(status.rawValue)")
            }
            defer { compression_stream_destroy(stream) }

            stream.pointee.src_ptr = srcBase
            stream.pointee.src_size = body.count

            repeat {
                stream.pointee.dst_ptr = dst
                stream.pointee.dst_size = chunk
                status = compression_stream_process(stream, Int32(COMPRESSION_STREAM_FINALIZE.rawValue))
                let produced = chunk - stream.pointee.dst_size
                if produced > 0 {
                    out.append(dst, count: produced)
                }
                if status == COMPRESSION_STATUS_ERROR {
                    throw TarGzError.inflateFailed("解压出错")
                }
            } while status == COMPRESSION_STATUS_OK
        }

        guard !out.isEmpty else { throw TarGzError.inflateFailed("解出 0 字节") }
        return out
    }
}
