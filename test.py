import sys

def mulberry32(seed):
    """返回一个生成器，每次迭代产生一个 [0, 1) 的浮点数"""
    state = seed & 0xFFFFFFFF          # 将种子截断为32位无符号整数
    while True:
        state = (state + 0x6d2b79f5) & 0xFFFFFFFF
        t = state

        # t = Math.imul(t ^ (t >>> 15), t | 1)
        x1 = t ^ (t >> 15)
        y1 = t | 1
        t = (x1 * y1) & 0xFFFFFFFF

        # t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        x2 = t ^ (t >> 7)
        y2 = t | 61
        inner = (x2 * y2) & 0xFFFFFFFF
        t = (t ^ ((t + inner) & 0xFFFFFFFF)) & 0xFFFFFFFF

        # ((t ^ (t >>> 14)) >>> 0) / 4294967296
        res = (t ^ (t >> 14)) & 0xFFFFFFFF
        yield res / 4294967296.0


if __name__ == "__main__":
    # 从命令行参数读取 seed，若无参数则交互式输入
    if len(sys.argv) > 1:
        seed = int(sys.argv[1])
    else:
        seed = int(input("Enter seed: "))

    rng = mulberry32(seed)
    print(next(rng))   # 第一个随机数
    print(next(rng))   # 第二个随机数